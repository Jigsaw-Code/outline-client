/*
  Copyright 2022 The Outline Authors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

// TODO(daniellacosse): requires electron context (should be somewhere in src/electron)
// import * as electronMain from './app/main.electron';
// import * as electronOutlineTunnel from './app/electron_outline_tunnel';

// TODO(daniellacosse): these modules have side effects, causing them to fail when we import into the test. They need to be encapsulated.
// import * as main from './app/main';
// import * as environment from './app/environment';
// import * as outlineIcons from './ui_components/outline-icons';

import * as clipboard from './app/clipboard';
import * as server from './app/outline_server_repository/server';
import * as platform from './app/platform';
import * as updater from './app/updater';
import * as urlInterceptor from './app/url_interceptor';
import * as vpnInstaller from './app/vpn_installer';
import * as errorReporter from './shared/error_reporter';
import * as appRoot from './ui_components/app-root.js';
import * as aboutView from './views/about_view';
import * as languageView from './views/language_view';
import * as addServerView from './views/root_view/add_access_key_dialog';
import * as userCommsDialog from './views/root_view/auto_connect_dialog';
import * as privacyView from './views/root_view/privacy_acknowledgement_dialog';

describe('TODOs', () => {
  it('loads all the files that have no tests against them', () => {
    // expect(environment).toBeDefined();
    // expect(main).toBeDefined();
    // expect(outlineIcons).toBeDefined();
    expect(aboutView).toBeDefined();
    expect(addServerView).toBeDefined();
    expect(appRoot).toBeDefined();
    expect(clipboard).toBeDefined();
    expect(errorReporter).toBeDefined();
    expect(languageView).toBeDefined();
    expect(platform).toBeDefined();
    expect(privacyView).toBeDefined();
    expect(server).toBeDefined();
    expect(updater).toBeDefined();
    expect(urlInterceptor).toBeDefined();
    expect(userCommsDialog).toBeDefined();
    expect(vpnInstaller).toBeDefined();
  });
});
