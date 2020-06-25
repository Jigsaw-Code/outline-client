// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {SHADOWSOCKS_URI} from 'ShadowsocksConfig/shadowsocks_config';

import * as errors from '../model/errors';
import * as events from '../model/events';
import {Server} from '../model/server';

import {Clipboard} from './clipboard';
import {EnvironmentVariables} from './environment';
import {OutlineErrorReporter} from './error_reporter';
import {PersistentServer, PersistentServerRepository} from './persistent_server';
import {Settings, SettingsKey} from './settings';
import {Updater} from './updater';
import {UrlInterceptor} from './url_interceptor';

// If s is a URL whose fragment contains a Shadowsocks URL then return that Shadowsocks URL,
// otherwise return s.
export function unwrapInvite(s: string): string {
  try {
    const url = new URL(s);
    if (url.hash) {
      const decodedFragment = decodeURIComponent(url.hash);

      // Search in the fragment for ss:// for two reasons:
      //  - URL.hash includes the leading # (what).
      //  - When a user opens invite.html#ENCODEDSSURL in their browser, the website (currently)
      //    redirects to invite.html#/en/invite/ENCODEDSSURL. Since copying that redirected URL
      //    seems like a reasonable thing to do, let's support those URLs too.
      const possibleShadowsocksUrl = decodedFragment.substring(decodedFragment.indexOf('ss://'));

      if (new URL(possibleShadowsocksUrl).protocol === 'ss:') {
        return possibleShadowsocksUrl;
      }
    }
  } catch (e) {
    // Something wasn't a URL, or it couldn't be decoded - no problem, people put all kinds of
    // crazy things in the clipboard.
  }
  return s;
}

export class App {
  private serverListEl: polymer.Base;
  private feedbackViewEl: polymer.Base;
  private localize: (...args: string[]) => string;
  private ignoredAccessKeys: {[accessKey: string]: boolean;} = {};

  constructor(
      private eventQueue: events.EventQueue, private serverRepo: PersistentServerRepository,
      private rootEl: polymer.Base, private debugMode: boolean,
      urlInterceptor: UrlInterceptor|undefined, private clipboard: Clipboard,
      private errorReporter: OutlineErrorReporter, private settings: Settings,
      private environmentVars: EnvironmentVariables, private updater: Updater,
      private quitApplication: () => void, document = window.document) {
    this.serverListEl = rootEl.$.serversView.$.serverList;
    this.feedbackViewEl = rootEl.$.feedbackView;

    this.syncServersToUI();
    this.syncConnectivityStateToServerCards();
    rootEl.$.aboutView.version = environmentVars.APP_VERSION;

    this.localize = this.rootEl.localize.bind(this.rootEl);

    if (urlInterceptor) {
      this.registerUrlInterceptionListener(urlInterceptor);
    } else {
      console.warn('no urlInterceptor, ss:// urls will not be intercepted');
    }

    this.clipboard.setListener(this.handleClipboardText.bind(this));

    this.updater.setListener(this.updateDownloaded.bind(this));

    // Register Cordova mobile foreground event to sync server connectivity.
    document.addEventListener('resume', this.syncConnectivityStateToServerCards.bind(this));

    // Register handlers for events fired by Polymer components.
    this.rootEl.addEventListener(
        'PromptAddServerRequested', this.requestPromptAddServer.bind(this));
    this.rootEl.addEventListener(
        'AddServerConfirmationRequested', this.requestAddServerConfirmation.bind(this));
    this.rootEl.addEventListener('AddServerRequested', this.requestAddServer.bind(this));
    this.rootEl.addEventListener('IgnoreServerRequested', this.requestIgnoreServer.bind(this));
    this.rootEl.addEventListener('ConnectPressed', this.connectServer.bind(this));
    this.rootEl.addEventListener('DisconnectPressed', this.disconnectServer.bind(this));
    this.rootEl.addEventListener('ForgetPressed', this.forgetServer.bind(this));
    this.rootEl.addEventListener('RenameRequested', this.renameServer.bind(this));
    this.rootEl.addEventListener('QuitPressed', this.quitApplication.bind(this));
    this.rootEl.addEventListener(
        'AutoConnectDialogDismissed', this.autoConnectDialogDismissed.bind(this));
    this.rootEl.addEventListener(
        'ShowServerRename', this.rootEl.showServerRename.bind(this.rootEl));
    this.rootEl.addEventListener('SubmitFeedbackRequested', this.submitFeedback.bind(this));
    this.rootEl.addEventListener('PrivacyTermsAcked', this.ackPrivacyTerms.bind(this));
    this.rootEl.addEventListener('SetLanguageRequested', this.setAppLanguage.bind(this));

    // Register handlers for events published to our event queue.
    this.eventQueue.subscribe(events.ServerAdded, this.showServerAdded.bind(this));
    this.eventQueue.subscribe(events.ServerForgotten, this.showServerForgotten.bind(this));
    this.eventQueue.subscribe(events.ServerRenamed, this.showServerRenamed.bind(this));
    this.eventQueue.subscribe(events.ServerForgetUndone, this.showServerForgetUndone.bind(this));
    this.eventQueue.subscribe(events.ServerConnected, this.showServerConnected.bind(this));
    this.eventQueue.subscribe(events.ServerDisconnected, this.showServerDisconnected.bind(this));
    this.eventQueue.subscribe(events.ServerReconnecting, this.showServerReconnecting.bind(this));

    this.eventQueue.startPublishing();

    if (!this.arePrivacyTermsAcked()) {
      this.displayPrivacyView();
    }
    this.displayZeroStateUi();
    this.pullClipboardText();
  }

  showLocalizedError(e?: Error, toastDuration = 10000) {
    let messageKey: string;
    let messageParams: string[]|undefined;
    let buttonKey: string;
    let buttonHandler: () => void;
    let buttonLink: string;

    if (e instanceof errors.VpnPermissionNotGranted) {
      messageKey = 'outline-plugin-error-vpn-permission-not-granted';
    } else if (e instanceof errors.InvalidServerCredentials) {
      messageKey = 'outline-plugin-error-invalid-server-credentials';
    } else if (e instanceof errors.RemoteUdpForwardingDisabled) {
      messageKey = 'outline-plugin-error-udp-forwarding-not-enabled';
    } else if (e instanceof errors.ServerUnreachable) {
      messageKey = 'outline-plugin-error-server-unreachable';
    } else if (e instanceof errors.FeedbackSubmissionError) {
      messageKey = 'error-feedback-submission';
    } else if (e instanceof errors.ServerUrlInvalid) {
      messageKey = 'error-invalid-access-key';
    } else if (e instanceof errors.ServerIncompatible) {
      messageKey = 'error-server-incompatible';
    } else if (e instanceof errors.OperationTimedOut) {
      messageKey = 'error-timeout';
    } else if (e instanceof errors.ShadowsocksStartFailure && this.isWindows()) {
      // Fall through to `error-unexpected` for other platforms.
      messageKey = 'outline-plugin-error-antivirus';
      buttonKey = 'fix-this';
      buttonLink = 'https://s3.amazonaws.com/outline-vpn/index.html#/en/support/antivirusBlock';
    } else if (e instanceof errors.ConfigureSystemProxyFailure) {
      messageKey = 'outline-plugin-error-routing-tables';
      buttonKey = 'feedback-page-title';
      buttonHandler = () => {
        // TODO: Drop-down has no selected item, why not?
        this.rootEl.changePage('feedback');
      };
    } else if (e instanceof errors.NoAdminPermissions) {
      messageKey = 'outline-plugin-error-admin-permissions';
    } else if (e instanceof errors.UnsupportedRoutingTable) {
      messageKey = 'outline-plugin-error-unsupported-routing-table';
    } else if (e instanceof errors.ServerAlreadyAdded) {
      messageKey = 'error-server-already-added';
      messageParams = ['serverName', e.server.name];
    } else if (e instanceof errors.SystemConfigurationException) {
      messageKey = 'outline-plugin-error-system-configuration';
    } else if (e instanceof errors.ShadowsocksUnsupportedCipher) {
      messageKey = 'error-shadowsocks-unsupported-cipher';
      messageParams = ['cipher', e.cipher];
    } else {
      messageKey = 'error-unexpected';
    }

    const message =
        messageParams ? this.localize(messageKey, ...messageParams) : this.localize(messageKey);

    // Defer by 500ms so that this toast is shown after any toasts that get shown when any
    // currently-in-flight domain events land (e.g. fake servers added).
    if (this.rootEl && this.rootEl.async) {
      this.rootEl.async(() => {
        this.rootEl.showToast(
            message, toastDuration, buttonKey ? this.localize(buttonKey) : undefined, buttonHandler,
            buttonLink);
      }, 500);
    }
  }

  private pullClipboardText() {
    this.clipboard.getContents().then(
        (text: string) => {
          this.handleClipboardText(text);
        },
        (e) => {
          console.warn('cannot read clipboard, system may lack clipboard support');
        });
  }

  private showServerConnected(event: events.ServerConnected): void {
    console.debug(`server ${event.server.id} connected`);
    const card = this.serverListEl.getServerCard(event.server.id);
    card.state = 'CONNECTED';
  }

  private showServerDisconnected(event: events.ServerDisconnected): void {
    console.debug(`server ${event.server.id} disconnected`);
    try {
      this.serverListEl.getServerCard(event.server.id).state = 'DISCONNECTED';
    } catch (e) {
      console.warn('server card not found after disconnection event, assuming forgotten');
    }
  }

  private showServerReconnecting(event: events.ServerReconnecting): void {
    console.debug(`server ${event.server.id} reconnecting`);
    const card = this.serverListEl.getServerCard(event.server.id);
    card.state = 'RECONNECTING';
  }

  private displayZeroStateUi() {
    if (this.rootEl.$.serversView.shouldShowZeroState) {
      this.rootEl.$.addServerView.openAddServerSheet();
    }
  }

  private arePrivacyTermsAcked() {
    try {
      return this.settings.get(SettingsKey.PRIVACY_ACK) === 'true';
    } catch (e) {
      console.error(`could not read privacy acknowledgement setting, assuming not acknowledged`);
    }
    return false;
  }

  private displayPrivacyView() {
    this.rootEl.$.serversView.hidden = true;
    this.rootEl.$.privacyView.hidden = false;
  }

  private ackPrivacyTerms() {
    this.rootEl.$.serversView.hidden = false;
    this.rootEl.$.privacyView.hidden = true;
    this.settings.set(SettingsKey.PRIVACY_ACK, 'true');
  }

  private setAppLanguage(event: CustomEvent) {
    const languageCode = event.detail.languageCode;
    window.localStorage.setItem('overrideLanguage', languageCode);
    this.rootEl.setLanguage(languageCode);
    this.changeToDefaultPage();
  }

  private handleClipboardText(text: string) {
    // Shorten, sanitise.
    // Note that we always check the text, even if the contents are same as last time, because we
    // keep an in-memory cache of user-ignored access keys.
    text = text.substring(0, 1000).trim();
    try {
      this.confirmAddServer(text, true);
    } catch (err) {
      // Don't alert the user; high false positive rate.
    }
  }

  private updateDownloaded() {
    this.rootEl.showToast(this.localize('update-downloaded'), 60000);
  }

  private requestPromptAddServer() {
    this.rootEl.promptAddServer();
  }

  // Caches an ignored server access key so we don't prompt the user to add it again.
  private requestIgnoreServer(event: CustomEvent) {
    const accessKey = event.detail.accessKey;
    this.ignoredAccessKeys[accessKey] = true;
  }

  private requestAddServer(event: CustomEvent) {
    try {
      this.serverRepo.add(event.detail.serverConfig);
    } catch (err) {
      this.changeToDefaultPage();
      this.showLocalizedError(err);
    }
  }

  private requestAddServerConfirmation(event: CustomEvent) {
    const accessKey = event.detail.accessKey;
    console.debug('Got add server confirmation request from UI');
    try {
      this.confirmAddServer(accessKey);
    } catch (err) {
      console.error('Failed to confirm add sever.', err);
      const addServerView = this.rootEl.$.addServerView;
      addServerView.$.accessKeyInput.invalid = true;
    }
  }

  private confirmAddServer(accessKey: string, fromClipboard = false) {
    const addServerView = this.rootEl.$.addServerView;
    accessKey = unwrapInvite(accessKey);
    if (fromClipboard && accessKey in this.ignoredAccessKeys) {
      return console.debug('Ignoring access key');
    } else if (fromClipboard && addServerView.isAddingServer()) {
      return console.debug('Already adding a server');
    }
    // Expect SHADOWSOCKS_URI.parse to throw on invalid access key; propagate any exception.
    let shadowsocksConfig = null;
    try {
      shadowsocksConfig = SHADOWSOCKS_URI.parse(accessKey);
    } catch (error) {
      const message = !!error.message ? error.message : 'Failed to parse access key';
      throw new errors.ServerUrlInvalid(message);
    }
    if (shadowsocksConfig.host.isIPv6) {
      throw new errors.ServerIncompatible('Only IPv4 addresses are currently supported');
    }
    const name = shadowsocksConfig.extra.outline ?
        this.localize('server-default-name-outline') :
        shadowsocksConfig.tag.data ? shadowsocksConfig.tag.data :
                                     this.localize('server-default-name');
    const serverConfig = {
      host: shadowsocksConfig.host.data,
      port: shadowsocksConfig.port.data,
      method: shadowsocksConfig.method.data,
      password: shadowsocksConfig.password.data,
      name,
    };
    if (!this.serverRepo.containsServer(serverConfig)) {
      // Only prompt the user to add new servers.
      try {
        addServerView.openAddServerConfirmationSheet(accessKey, serverConfig);
      } catch (err) {
        console.error('Failed to open add sever confirmation sheet:', err.message);
        if (!fromClipboard) this.showLocalizedError();
      }
    } else if (!fromClipboard) {
      // Display error message if this is not a clipboard add.
      addServerView.close();
      this.showLocalizedError(new errors.ServerAlreadyAdded(
          this.serverRepo.createServer('', serverConfig, this.eventQueue)));
    }
  }

  private forgetServer(event: CustomEvent) {
    const serverId = event.detail.serverId;
    const server = this.serverRepo.getById(serverId);
    if (!server) {
      console.error(`No server with id ${serverId}`);
      return this.showLocalizedError();
    }
    const onceNotRunning = server.checkRunning().then((isRunning) => {
      return isRunning ? this.disconnectServer(event) : Promise.resolve();
    });
    onceNotRunning.then(() => {
      this.serverRepo.forget(serverId);
    });
  }

  private renameServer(event: CustomEvent) {
    const serverId = event.detail.serverId;
    const newName = event.detail.newName;
    this.serverRepo.rename(serverId, newName);
  }

  private connectServer(event: CustomEvent): void {
    const serverId = event.detail.serverId;
    if (!serverId) {
      throw new Error(`connectServer event had no server ID`);
    }

    const server = this.getServerByServerId(serverId);
    const card = this.getCardByServerId(serverId);

    console.log(`connecting to server ${serverId}`);

    card.state = 'CONNECTING';
    server.connect().then(
        () => {
          card.state = 'CONNECTED';
          console.log(`connected to server ${serverId}`);
          this.rootEl.showToast(this.localize('server-connected', 'serverName', server.name));
          this.maybeShowAutoConnectDialog();
        },
        (e) => {
          card.state = 'DISCONNECTED';
          this.showLocalizedError(e);
          console.error(`could not connect to server ${serverId}: ${e.name}`);
          if (!(e instanceof errors.RegularNativeError)) {
            this.errorReporter.report(`connection failure: ${e.name}`, 'connection-failure');
          }
        });
  }

  private maybeShowAutoConnectDialog() {
    let dismissed = false;
    try {
      dismissed = this.settings.get(SettingsKey.AUTO_CONNECT_DIALOG_DISMISSED) === 'true';
    } catch (e) {
      console.error(`Failed to read auto-connect dialog status, assuming not dismissed: ${e}`);
    }
    if (!dismissed) {
      this.rootEl.$.serversView.$.autoConnectDialog.show();
    }
  }

  private autoConnectDialogDismissed() {
    this.settings.set(SettingsKey.AUTO_CONNECT_DIALOG_DISMISSED, 'true');
  }

  private disconnectServer(event: CustomEvent): void {
    const serverId = event.detail.serverId;
    if (!serverId) {
      throw new Error(`disconnectServer event had no server ID`);
    }

    const server = this.getServerByServerId(serverId);
    const card = this.getCardByServerId(serverId);

    console.log(`disconnecting from server ${serverId}`);

    card.state = 'DISCONNECTING';
    server.disconnect().then(
        () => {
          card.state = 'DISCONNECTED';
          console.log(`disconnected from server ${serverId}`);
          this.rootEl.showToast(this.localize('server-disconnected', 'serverName', server.name));
        },
        (e) => {
          card.state = 'CONNECTED';
          this.showLocalizedError(e);
          console.warn(`could not disconnect from server ${serverId}: ${e.name}`);
        });
  }

  private submitFeedback(event: CustomEvent) {
    if (!event.detail) {
      return;
    }
    const {feedback, category, email} = event.detail;
    this.rootEl.$.feedbackView.submitting = true;
    this.errorReporter.report(feedback, category, email)
        .then(
            () => {
              this.rootEl.$.feedbackView.submitting = false;
              this.rootEl.$.feedbackView.resetForm();
              this.changeToDefaultPage();
              this.rootEl.showToast(this.rootEl.localize('feedback-thanks'));
            },
            (err: {}) => {
              this.rootEl.$.feedbackView.submitting = false;
              this.showLocalizedError(new errors.FeedbackSubmissionError());
            });
  }

  // EventQueue event handlers:

  private showServerAdded(event: events.ServerAdded) {
    const server = event.server;
    console.debug('Server added');
    this.syncServersToUI();
    this.syncServerConnectivityState(server);
    this.changeToDefaultPage();
    this.rootEl.showToast(this.localize('server-added', 'serverName', server.name));
  }

  private showServerForgotten(event: events.ServerForgotten) {
    const server = event.server;
    console.debug('Server forgotten');
    this.syncServersToUI();
    this.rootEl.showToast(
        this.localize('server-forgotten', 'serverName', server.name), 10000,
        this.localize('undo-button-label'), () => {
          this.serverRepo.undoForget(server.id);
        });
  }

  private showServerForgetUndone(event: events.ServerForgetUndone) {
    this.syncServersToUI();
    const server = event.server;
    this.rootEl.showToast(this.localize('server-forgotten-undo', 'serverName', server.name));
  }

  private showServerRenamed(event: events.ServerForgotten) {
    const server = event.server;
    console.debug('Server renamed');
    this.serverListEl.getServerCard(server.id).serverName = server.name;
    this.rootEl.showToast(this.localize('server-rename-complete'));
  }

  // Helpers:

  private syncServersToUI() {
    this.rootEl.servers = this.serverRepo.getAll();
  }

  private syncConnectivityStateToServerCards() {
    for (const server of this.serverRepo.getAll()) {
      this.syncServerConnectivityState(server);
    }
  }

  private syncServerConnectivityState(server: Server) {
    server.checkRunning()
        .then((isRunning) => {
          const card = this.serverListEl.getServerCard(server.id);
          if (!isRunning) {
            card.state = 'DISCONNECTED';
            return;
          }
          server.checkReachable().then((isReachable) => {
            if (isReachable) {
              card.state = 'CONNECTED';
            } else {
              console.log(`Server ${server.id} reconnecting`);
              card.state = 'RECONNECTING';
            }
          });
        })
        .catch((e) => {
          console.error('Failed to sync server connectivity state', e);
        });
  }

  private registerUrlInterceptionListener(urlInterceptor: UrlInterceptor) {
    urlInterceptor.registerListener((url) => {
      if (!url || !unwrapInvite(url).startsWith('ss://')) {
        // This check is necessary to ignore empty and malformed install-referrer URLs in Android
        // while allowing ss:// and invite URLs.
        // TODO: Stop receiving install referrer intents so we can remove this.
        return console.debug(`Ignoring intercepted non-shadowsocks url`);
      }
      try {
        this.confirmAddServer(url);
      } catch (err) {
        this.showLocalizedErrorInDefaultPage(err);
      }
    });
  }

  private changeToDefaultPage() {
    this.rootEl.changePage(this.rootEl.DEFAULT_PAGE);
  }

  // Returns the server having serverId, throws if the server cannot be found.
  private getServerByServerId(serverId: string): PersistentServer {
    const server = this.serverRepo.getById(serverId);
    if (!server) {
      throw new Error(`could not find server with ID ${serverId}`);
    }
    return server;
  }

  // Returns the card associated with serverId, throws if no such card exists.
  // See server-list.html.
  private getCardByServerId(serverId: string) {
    return this.serverListEl.getServerCard(serverId);
  }

  private showLocalizedErrorInDefaultPage(err: Error) {
    this.changeToDefaultPage();
    this.showLocalizedError(err);
  }

  private isWindows() {
    return !('cordova' in window);
  }
}
