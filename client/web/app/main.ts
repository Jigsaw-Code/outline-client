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

import '../ui_components/app-root.js';

import {Localizer} from '@outline/infrastructure/i18n';
import {makeConfig, SIP002_URI} from 'ShadowsocksConfig';

import {App} from './app';
import {onceEnvVars} from './environment';
import {newOutlineServerRepository} from './outline_server_repository';
import {
  FAKE_BROKEN_HOSTNAME,
  FAKE_UNREACHABLE_HOSTNAME,
  FakeVpnApi,
} from './outline_server_repository/vpn.fake';
import {OutlinePlatform} from './platform';
import {Settings} from './settings';
import {EventQueue} from '../model/events';
import {ServerRepository} from '../model/server.js';

// Used to determine whether to use Polymer functionality on app initialization failure.
let webComponentsAreReady = false;
document.addEventListener('WebComponentsReady', () => {
  console.debug('received WebComponentsReady event');
  webComponentsAreReady = true;
});

// Used to delay loading the app until (translation) resources have been loaded. This can happen a
// little later than WebComponentsReady.
const oncePolymerIsReady = new Promise<void>(resolve => {
  document.addEventListener('app-localize-resources-loaded', () => {
    console.debug('received app-localize-resources-loaded event');
    resolve();
  });
});

// Helpers

// Do not call until WebComponentsReady has fired!
function getRootEl() {
  return document.querySelector('app-root') as {} as polymer.Base;
}

async function createServerRepo(
  platform: OutlinePlatform,
  eventQueue: EventQueue
): Promise<ServerRepository> {
  const localize = getLocalizationFunction();
  const vpnApi = platform.getVpnApi();
  if (vpnApi) {
    return await newOutlineServerRepository(
      vpnApi,
      eventQueue,
      window.localStorage,
      localize
    );
  }

  console.debug('Platform not supported, using fake servers.');
  const repo = await newOutlineServerRepository(
    new FakeVpnApi(),
    eventQueue,
    window.localStorage,
    localize
  );

  if (repo.getAll().length === 0) {
    repo.add(
      SIP002_URI.stringify(
        makeConfig({
          host: '127.0.0.1',
          port: 123,
          method: 'chacha20-ietf-poly1305',
          tag: 'Fake Working Server',
        })
      )
    );
    repo.add(
      SIP002_URI.stringify(
        makeConfig({
          host: FAKE_BROKEN_HOSTNAME,
          port: 123,
          method: 'chacha20-ietf-poly1305',
          tag: 'Fake Broken Server',
        })
      )
    );
    repo.add(
      SIP002_URI.stringify(
        makeConfig({
          host: FAKE_UNREACHABLE_HOSTNAME,
          port: 123,
          method: 'chacha20-ietf-poly1305',
          tag: 'Fake Unreachable Server',
        })
      )
    );
  }
  return repo;
}

export function main(platform: OutlinePlatform) {
  return Promise.all([onceEnvVars, oncePolymerIsReady]).then(
    async ([environmentVars]) => {
      console.debug('running main() function');

      const queryParams = new URL(document.URL).searchParams;
      const debugMode = queryParams.get('debug') === 'true';

      const eventQueue = new EventQueue();
      const serverRepo = await createServerRepo(platform, eventQueue);
      const settings = new Settings();
      return new App(
        eventQueue,
        serverRepo,
        getRootEl(),
        debugMode,
        platform.getUrlInterceptor(),
        platform.getClipboard(),
        platform.getErrorReporter(environmentVars),
        settings,
        environmentVars,
        platform.getUpdater(),
        platform.getVpnServiceInstaller(),
        platform.quitApplication
      );
    },
    e => {
      onUnexpectedError(e);
    }
  );
}

function onUnexpectedError(error: Error) {
  const rootEl = getRootEl();
  if (webComponentsAreReady && rootEl && rootEl.localize) {
    const localize = rootEl.localize.bind(rootEl);
    rootEl.showToast(localize('error-unexpected'), 120000);
  } else {
    // Something went terribly wrong (i.e. Polymer failed to initialize). Provide some messaging to
    // the user, even if we are not able to display it in a toast or localize it.
    alert(
      'An unexpected error occurred. Please contact support@getoutline.org for assistance.'
    );
  }
  console.error(error);
}

// Returns Polymer's localization function. Must be called after WebComponentsReady has fired.
export function getLocalizationFunction(): Localizer {
  const rootEl = getRootEl();
  if (!rootEl) {
    return null;
  }
  return rootEl.localize;
}
