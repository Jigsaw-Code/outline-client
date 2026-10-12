// Copyright 2026 The Outline Authors
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

import path from 'path';
import url from 'url';

import {spawnStream} from '@outline/infrastructure/build/spawn_stream.mjs';

import {buildWebBundle} from './web_bundle.mjs';
import {getBuildParameters} from '../build/get_build_parameters.mjs';

const capacitorDir = path.dirname(url.fileURLToPath(import.meta.url));

const CAPACITOR_PLATFORMS = ['android', 'ios'];

/**
 * @description Fully builds the Capacitor client: the web bundle, the
 * tun2socks native library, and the native app binary.
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  const buildParameters = getBuildParameters(parameters);
  const {platform, buildMode, verbose} = buildParameters;

  if (!CAPACITOR_PLATFORMS.includes(platform)) {
    throw new TypeError(
      `Capacitor build.action.mjs supports platforms ${CAPACITOR_PLATFORMS.join(', ')}, got "${platform}".`
    );
  }

  // TODO: Support a release build once we're ready to migrate to Capacitor.
  if (buildMode !== 'debug') {
    throw new TypeError(
      `Capacitor ${platform} build supports only debug mode, got "${buildMode}".`
    );
  }

  // Build the web bundle (client/capacitor/www/) that `cap sync` copies into
  // the native project.
  await buildWebBundle(buildParameters);

  // `cap sync` first runs the capacitor:sync:before hook (see package.json in
  // this directory), which builds the tun2socks native library for the
  // platform: the gomobile AAR (plus client:android:configure) on Android, and
  // the Tun2socks.xcframework that ios/App/App.xcodeproj links from
  // output/client/apple/ on iOS. It then copies the web assets into the native
  // project and refreshes the Capacitor plugins. The Capacitor CLI locates the
  // project from the working directory.
  process.chdir(capacitorDir);
  await spawnStream('npx', 'cap', 'sync', platform);

  switch (platform) {
    case 'android':
      return androidDebug(verbose);
    case 'ios':
      return iosDebug(verbose);
  }
}

async function androidDebug(verbose) {
  // `cap build` only produces signed release builds, so invoke Gradle
  // directly for the debug APK — the same target `cap run` uses.
  // TODO: Migrate to a release Gradle target once we have a production build.
  const androidDir = path.resolve(capacitorDir, 'android');
  await spawnStream(
    path.join(androidDir, 'gradlew'),
    '-p',
    androidDir,
    verbose ? '--info' : '--quiet',
    'assembleDebug'
  );
}

async function iosDebug(verbose) {
  // `cap build` only produces signed release builds, so invoke xcodebuild
  // directly for an unsigned debug build, the same way the Cordova iOS build
  // does (see client/src/cordova/build.action.mjs). Signing is disabled so the
  // build needs no development team or provisioning profile, which CI does not
  // have.
  // TODO: Migrate to an archive once we have a production build.
  console.warn(
    'WARNING: building "ios" in [DEBUG] mode. Do not publish this build!!'
  );
  await spawnStream(
    'xcodebuild',
    'clean',
    '-project',
    path.resolve(capacitorDir, 'ios', 'App', 'App.xcodeproj'),
    '-scheme',
    'Outline',
    '-destination',
    'generic/platform=iOS',
    'build',
    '-configuration',
    'Debug',
    ...(verbose ? [] : ['-quiet']),
    'CODE_SIGN_IDENTITY=',
    'CODE_SIGNING_ALLOWED=NO'
  );
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
