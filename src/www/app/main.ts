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

import * as url from 'url';

import {EventQueue} from '../model/events';

import {App} from './app';
import {onceEnvVars} from './environment';
import {PersistentServerFactory, PersistentServerRepository} from './persistent_server';
import {OutlinePlatform} from './platform';
import {Settings} from './settings';

// Used to determine whether to use Polymer functionality on app initialization failure.
let webComponentsAreReady = false;
document.addEventListener('WebComponentsReady', () => {
  console.debug('received WebComponentsReady event');
  webComponentsAreReady = true;
});

// Used to delay loading the app until (translation) resources have been loaded. This can happen a
// little later than WebComponentsReady.
const oncePolymerIsReady = new Promise((resolve) => {
  document.addEventListener('app-localize-resources-loaded', () => {
    console.debug('received app-localize-resources-loaded event');
    resolve();
  });
});

// Helpers

// Do not call until WebComponentsReady has fired!
function getRootEl() {
  return (document.querySelector('app-root') as {}) as polymer.Base;
}

function createServerRepo(
    eventQueue: EventQueue, storage: Storage, deviceSupport: boolean,
    serverFactory: PersistentServerFactory) {
  const repo = new PersistentServerRepository(serverFactory, eventQueue, storage);
  if (!deviceSupport) {
    console.debug('Detected development environment, using fake servers.');
    if (repo.getAll().length === 0) {
      repo.add({
        name: 'Fake Working Server',
        proxy: {host: '127.0.0.1', port: 123, method: 'chacha20-ietf-poly1305'}
      });
      repo.add({
        name: 'Fake Broken Server',
        proxy: {host: '192.0.2.1', port: 123, method: 'chacha20-ietf-poly1305'}
      });
      repo.add({
        name: 'Fake Unreachable Server',
        proxy: {host: '10.0.0.24', port: 123, method: 'chacha20-ietf-poly1305'}
      });
    }
  }
  return repo;
}

export function main(platform: OutlinePlatform) {
  return Promise.all([onceEnvVars, oncePolymerIsReady])
      .then(
          ([environmentVars]) => {
            console.debug('running main() function');

            const queryParams = url.parse(document.URL, true).query;
            const debugMode = queryParams.debug === 'true';

            const eventQueue = new EventQueue();
            const serverRepo = createServerRepo(
                eventQueue, window.localStorage, platform.hasDeviceSupport(),
                platform.getPersistentServerFactory());
            const settings = new Settings();
            const app = new App(
                eventQueue, serverRepo, getRootEl(), debugMode, platform.getUrlInterceptor(),
                platform.getClipboard(), platform.getErrorReporter(environmentVars), settings,
                environmentVars, platform.getUpdater(), platform.quitApplication);
          },
          (e) => {
            onUnexpectedError(e);
          });
}

function onUnexpectedError(error: Error) {
  const rootEl = getRootEl();
  if (webComponentsAreReady && rootEl && rootEl.localize) {
    const localize = rootEl.localize.bind(rootEl);
    rootEl.showToast(localize('error-unexpected'), 120000);
  } else {
    // Something went terribly wrong (i.e. Polymer failed to initialize). Provide some messaging to
    // the user, even if we are not able to display it in a toast or localize it.
    alert(`An unexpected error occurred. Please contact support@getoutline.org for assistance.`);
  }
  console.error(error);
}

// Returns Polymer's localization function. Must be called after WebComponentsReady has fired.
export function getLocalizationFunction() {
  const rootEl = getRootEl();
  if (!rootEl) {
    return null;
  }
  return rootEl.localize;
}
