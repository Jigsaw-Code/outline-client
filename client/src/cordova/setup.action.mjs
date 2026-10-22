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

import os from 'os';
import path from 'path';
import url from 'url';

import {getRootDir} from '@outline/infrastructure/build/get_root_dir.mjs';
import {runAction} from '@outline/infrastructure/build/run_action.mjs';
import {spawnStream} from '@outline/infrastructure/build/spawn_stream.mjs';
import cordovaLib from 'cordova-lib';
import rmfr from 'rmfr';

import {getBuildParameters} from '../../build/get_build_parameters.mjs';
import {makeReplacements} from '../../build/make_replacements.mjs';

const {cordova} = cordovaLib;

/**
 * @description Prepares the paramterized cordova project (ios, macos, android) for being built.
 * We have a couple custom things we must do - like rsyncing code from our apple project into the project
 * cordova creates.
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  const {platform, buildMode, verbose, buildNumber, versionName} =
    getBuildParameters(parameters);

  await runAction('client/web/build', ...parameters);
  await runAction('client/go/build', ...parameters);

  const CORDOVA_PROJECT_DIR = path.resolve(getRootDir(), 'client');
  await rmfr(path.resolve(CORDOVA_PROJECT_DIR, 'platforms'));
  await rmfr(path.resolve(CORDOVA_PROJECT_DIR, 'plugins'));

  if (verbose) {
    cordova.on('verbose', message =>
      console.debug(`[cordova:verbose] ${message}`)
    );
  }

  // This is so Cordova doesn't complain about not being in a cordova project
  process.env.PWD = path.resolve(getRootDir(), 'client');

  switch (platform + buildMode) {
    case 'android' + 'debug':
      return androidDebug(verbose);
    case 'android' + 'release':
      console.warn(
        'NOTE: You must open the Outline.zip file after building to upload to the Play Store.'
      );
      return androidRelease(versionName, buildNumber, verbose);
    case 'ios' + 'debug':
    case 'macos' + 'debug':
      return appleDebug(verbose);
    case 'ios' + 'release':
    case 'macos' + 'release':
      return appleRelease(versionName, buildNumber, verbose);
    case 'browser' + 'debug':
    default:
      return cordova.prepare({
        platforms: ['browser'],
        save: false,
      });
  }
}

async function androidDebug(verbose) {
  await cordova.prepare({
    platforms: ['android'],
    save: false,
    verbose,
  });
}

async function androidRelease(versionName, buildNumber, verbose) {
  await cordova.prepare({
    platforms: ['android'],
    save: false,
    verbose,
  });

  const manifestXmlGlob = path.join(
    getRootDir(),
    'client',
    'platforms',
    'android',
    '**',
    'AndroidManifest.xml'
  );
  const configXmlGlob = path.join(
    getRootDir(),
    'client',
    'platforms',
    'android',
    '**',
    'config.xml'
  );

  await makeReplacements([
    {
      files: manifestXmlGlob,
      from: ['android:versionName="1.0"', 'android:versionName="0.0.0-debug"'],
      to: `android:versionName="${versionName}"`,
    },
    {
      files: manifestXmlGlob,
      from: 'android:versionCode="1"',
      to: `android:versionCode="${buildNumber}"`,
    },
    {
      files: configXmlGlob,
      from: 'version="0.0.0-debug"',
      to: `version="${versionName}"`,
    },
    {
      files: configXmlGlob,
      from: 'android-versionCode="1"',
      to: `android-versionCode="${buildNumber}"`,
    },
  ]);
}

async function appleDebug(verbose) {
  if (os.platform() !== 'darwin') {
    throw new Error(
      'Building an Apple binary requires xcodebuild and can only be done on MacOS'
    );
  }

  await cordova.prepare({
    platforms: ['ios'],
    save: false,
    verbose,
  });

  // TODO(daniellacosse): move this to a cordova hook
  await spawnStream(
    'rsync',
    '-avc',
    'src/cordova/apple/xcode/',
    'platforms/ios/'
  );
}

async function setAppleVersion(platform, versionName, buildNumber) {
  const applePlists = [
    `platforms/${platform}/Outline/*.plist`,
    `platforms/${platform}/OutlineControls/*.plist`,
  ];
  await makeReplacements([
    {
      files: applePlists,
      from: /<key>CFBundleShortVersionString<\/key>\s*<string>.*<\/string>/g,
      to: `<key>CFBundleShortVersionString</key>\n  <string>${versionName}</string>`,
    },
    {
      files: applePlists,
      from: /<key>CFBundleVersion<\/key>\s*<string>.*<\/string>/g,
      to: `<key>CFBundleVersion</key>\n  <string>${buildNumber}</string>`,
    },
  ]);
}

async function appleRelease(version, buildNumber, verbose) {
  if (os.platform() !== 'darwin') {
    throw new Error(
      'Building an Apple binary requires xcodebuild and can only be done on MacOS'
    );
  }

  await cordova.prepare({
    platforms: ['ios'],
    save: false,
    verbose,
  });

  // TODO(daniellacosse): move this to a cordova hook
  await spawnStream(
    'rsync',
    '-avc',
    'src/cordova/apple/xcode/',
    'platforms/ios/'
  );

  await setAppleVersion('ios', version, buildNumber);
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
