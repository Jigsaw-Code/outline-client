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

/// <reference path='../../types/ambient/outlinePlugin.d.ts'/>
/// <reference path='../../types/ambient/webintents.d.ts'/>

import * as sentry from '@sentry/browser';

import {EventQueue} from '../model/events';
import {ServerConfig} from '../model/server';

import {AbstractClipboard, Clipboard, ClipboardListener} from './clipboard';
import {EnvironmentVariables} from './environment';
import {SentryErrorReporter} from './error_reporter';
import {FakeOutlineTunnel} from './fake_tunnel';
import {main} from './main';
import {OutlineServer} from './outline_server';
import {OutlinePlatform} from './platform';
import {AbstractUpdater} from './updater';
import * as interceptors from './url_interceptor';

// Pushes a clipboard event whenever the app is brought to the foreground.
class CordovaClipboard extends AbstractClipboard {
  constructor() {
    super();
    document.addEventListener('resume', this.emitEvent.bind(this));
  }

  getContents() {
    return new Promise<string>((resolve, reject) => {
      cordova.plugins.clipboard.paste(resolve, reject);
    });
  }
}

// Adds reports from the (native) Cordova plugin.
export class CordovaErrorReporter extends SentryErrorReporter {
  constructor(appVersion: string, appBuildNumber: string, dsn: string) {
    super(appVersion, dsn, {'build.number': appBuildNumber});
    cordova.plugins.outline.log.initialize(dsn).catch(console.error);
  }

  async report(userFeedback: string, feedbackCategory: string, userEmail?: string) {
    await super.report(userFeedback, feedbackCategory, userEmail);
    await cordova.plugins.outline.log.send(sentry.lastEventId() || '');
  }
}

// This class should only be instantiated after Cordova fires the deviceready event.
class CordovaPlatform implements OutlinePlatform {
  private static isBrowser() {
    return device.platform === 'browser';
  }

  hasDeviceSupport() {
    return !CordovaPlatform.isBrowser();
  }

  getPersistentServerFactory() {
    return (serverId: string, config: ServerConfig, eventQueue: EventQueue) => {
      return new OutlineServer(
          serverId, config,
          this.hasDeviceSupport() ? new cordova.plugins.outline.Tunnel(serverId, config.proxy) :
                                    new FakeOutlineTunnel(serverId, config.proxy),
          eventQueue);
    };
  }

  getUrlInterceptor() {
    if (device.platform === 'iOS' || device.platform === 'Mac OS X') {
      return new interceptors.AppleUrlInterceptor(appleLaunchUrl);
    } else if (device.platform === 'Android') {
      return new interceptors.AndroidUrlInterceptor();
    }
    console.warn('no intent interceptor available');
    return new interceptors.UrlInterceptor();
  }

  getClipboard() {
    return new CordovaClipboard();
  }

  getErrorReporter(env: EnvironmentVariables) {
    return this.hasDeviceSupport() ?
        new CordovaErrorReporter(env.APP_VERSION, env.APP_BUILD_NUMBER, env.SENTRY_DSN || '') :
        new SentryErrorReporter(env.APP_VERSION, env.SENTRY_DSN || '', {});
  }

  getUpdater() {
    return new AbstractUpdater();
  }

  quitApplication() {
    // Only used in macOS because menu bar apps provide no alternative way of quitting.
    cordova.plugins.outline.quitApplication();
  }
}

// https://cordova.apache.org/docs/en/latest/cordova/events/events.html#deviceready
const onceDeviceReady = new Promise((resolve) => {
  document.addEventListener('deviceready', resolve);
});

// cordova-[ios|osx] call a global function with this signature when a URL is
// intercepted. We handle URL interceptions with an intent interceptor; however,
// when the app is launched via URL our start up sequence misses the call due to
// a race. Define the function temporarily here, and set a global variable.
let appleLaunchUrl: string;
window.handleOpenURL = (url: string) => {
  appleLaunchUrl = url;
};

onceDeviceReady.then(() => {
  main(new CordovaPlatform());
});
