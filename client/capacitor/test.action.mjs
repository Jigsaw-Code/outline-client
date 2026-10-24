// Copyright 2022 The Outline Authors
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

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import url from 'url';

import {getRootDir} from '@outline/infrastructure/build/get_root_dir.mjs';
import {runAction} from '@outline/infrastructure/build/run_action.mjs';
import {spawnStream} from '@outline/infrastructure/build/spawn_stream.mjs';

const IOS_ROOT = path.join(getRootDir(), 'client', 'capacitor', 'ios');

const SUPPORTED_PLATFORMS = new Set(['ios']);
// The simulator CI's macOS runner provides. Override locally with
// `-- --simulator="iPhone 17"` (see `xcrun simctl list devices`).
const DEFAULT_SIMULATOR = 'iPhone 16';

/**
 * @description Runs the native unit tests of the Apple VPN extension
 * (ios/OutlineLib, scheme VpnExtensionTest) on the iOS Simulator.
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  const [outlinePlatform = 'ios'] = parameters.filter(
    parameter => !parameter.startsWith('--')
  );
  const simulator =
    parameters
      .find(parameter => parameter.startsWith('--simulator='))
      ?.slice('--simulator='.length) || DEFAULT_SIMULATOR;

  if (!SUPPORTED_PLATFORMS.has(outlinePlatform)) {
    throw new Error(
      'Testing is only currently supported for platforms: ' +
        Array.from(SUPPORTED_PLATFORMS)
    );
  }

  if (os.platform() !== 'darwin') {
    throw new Error(
      'Building an Apple binary requires xcodebuild and can only be done on MacOS'
    );
  }

  const derivedDataPath = path.join(
    process.env.COVERAGE_DIR,
    'apple',
    outlinePlatform
  );

  await fs.rm(derivedDataPath, {recursive: true, force: true});
  // The VPN extension links the Tun2socks.xcframework from output/client/apple.
  await runAction('client/go/build', outlinePlatform);
  await spawnStream(
    'xcodebuild',
    'test',
    '-scheme',
    'VpnExtensionTest',
    '-destination',
    `platform=iOS Simulator,OS=latest,name=${simulator}`,
    '-project',
    path.join(IOS_ROOT, 'OutlineLib', 'OutlineLib.xcodeproj'),
    '-enableCodeCoverage',
    'YES',
    '-derivedDataPath',
    derivedDataPath,
    'CODE_SIGN_IDENTITY=""',
    'CODE_SIGNING_ALLOWED="NO"'
  );

  const testCoverageDirectoryPath = path.join(derivedDataPath, 'Logs', 'Test');
  const testCoverageResultFilename = (
    await fs.readdir(testCoverageDirectoryPath)
  ).find(filename => filename.endsWith('xcresult'));

  await fs.rename(
    path.join(testCoverageDirectoryPath, testCoverageResultFilename),
    path.join(derivedDataPath, 'TestResult.xcresult')
  );
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
