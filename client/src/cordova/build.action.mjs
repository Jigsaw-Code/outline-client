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

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'url';

import {getRootDir} from '@outline/infrastructure/build/get_root_dir.mjs';
import {runAction} from '@outline/infrastructure/build/run_action.mjs';
import {spawnStream} from '@outline/infrastructure/build/spawn_stream.mjs';
import cordovaLib from 'cordova-lib';
import * as dotenv from 'dotenv';

const {cordova} = cordovaLib;

import {buildUniversalApkSet} from '../../build/android_universal_apk.mjs';
import {getBuildParameters} from '../../build/get_build_parameters.mjs';

const CORDOVA_PLATFORMS = ['android', 'ios', 'macos'];

/**
 * @description Builds the parameterized cordova binary (ios, macos, android).
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  const {platform, buildMode, verbose} = getBuildParameters(parameters);

  if (!CORDOVA_PLATFORMS.includes(platform)) {
    throw new TypeError(
      `The platform "${platform}" is not a valid Cordova platform. It must be one of: ${CORDOVA_PLATFORMS.join(
        ', '
      )}.`
    );
  }

  await runAction('client/src/cordova/setup', ...parameters);

  if (verbose) {
    cordova.on('verbose', message =>
      console.debug(`[cordova:verbose] ${message}`)
    );
  }

  // this is so cordova doesn't complain about not being in a cordova project
  process.env.PWD = path.resolve(getRootDir(), 'client');

  if (platform === 'android') {
    await spawnStream('go', 'tool', 'task', 'client:android:configure');
    dotenv.config({
      path: path.resolve(getRootDir(), 'output', 'client', 'android', '.env'),
    });
  }

  switch (platform + buildMode) {
    case 'android' + 'debug':
      return androidDebug(verbose);
    case 'android' + 'release':
      if (!process.env.JAVA_HOME) {
        throw new ReferenceError(
          'JAVA_HOME must be defined in the environment to build an Android Release!'
        );
      }

      if (
        !(
          process.env.ANDROID_KEY_STORE_PASSWORD &&
          process.env.ANDROID_KEY_STORE_CONTENTS
        )
      ) {
        throw new ReferenceError(
          "Both 'ANDROID_KEY_STORE_PASSWORD' and 'ANDROID_KEY_STORE_CONTENTS' must be defined in the environment to build an Android Release!"
        );
      }

      return androidRelease(
        process.env.ANDROID_KEY_STORE_PASSWORD,
        process.env.ANDROID_KEY_STORE_CONTENTS,
        process.env.JAVA_HOME,
        verbose
      );
    case 'ios' + 'debug':
    case 'macos' + 'debug':
      return appleDebug(platform);
    case 'ios' + 'release':
    case 'macos' + 'release':
      return appleRelease(platform);
  }
}

function getXcodeBuildArgs(platform) {
  let destination, workspaceFilename;
  switch (platform) {
    case 'macos':
      destination = 'generic/platform=macOS,variant=Mac Catalyst';
      workspaceFilename = 'client.xcworkspace';
      break;
    case 'ios':
    default:
      destination = 'generic/platform=iOS';
      workspaceFilename = 'client.xcworkspace';
      break;
  }
  return [
    '-workspace',
    path.join(
      getRootDir(),
      'client',
      'src',
      'cordova',
      'apple',
      workspaceFilename
    ),
    '-scheme',
    'Outline',
    '-destination',
    destination,
  ];
}

async function appleDebug(platform) {
  console.warn(
    `WARNING: building "${platform}" in [DEBUG] mode. Do not publish this build!!`
  );

  return spawnStream(
    'xcodebuild',
    'clean',
    ...getXcodeBuildArgs(platform),
    'build',
    '-configuration',
    'Debug',
    '-allowProvisioningUpdates',
    'CODE_SIGN_IDENTITY=""',
    'CODE_SIGNING_ALLOWED="NO"'
  );
}

async function appleRelease(platform) {
  const teamIdArgs = process.env.DEVELOPMENT_TEAM
    ? [`DEVELOPMENT_TEAM=${process.env.DEVELOPMENT_TEAM}`]
    : [];

  return spawnStream(
    'xcodebuild',
    'clean',
    ...getXcodeBuildArgs(platform),
    'archive',
    '-configuration',
    'Release',
    '-allowProvisioningUpdates',
    ...teamIdArgs
  );
}

async function androidDebug(verbose) {
  console.warn(
    'WARNING: building "android" in [DEBUG] mode. Do not publish this build!!'
  );

  // Alternatively:
  // npx cordova build android -- --gradleArg=--include-build=../../src/cordova/android/OutlineAndroidLib
  return cordova.compile({
    verbose,
    platforms: ['android'],
    options: {
      argv: [
        // Path is relative to $WORKSPACE/client/platforms/android/.
        // See https://docs.gradle.org/current/userguide/composite_builds.html#command_line_composite
        // TODO(fortuna): Can we embed this in the gradle settings instead?
        '--gradleArg=--include-build=../../src/cordova/android/OutlineAndroidLib',
        verbose ? '--gradleArg=--info' : '--gradleArg=--quiet',
      ],
    },
  });
}

async function androidRelease(ksPassword, ksContents, javaPath, verbose) {
  const androidBuildPath = path.resolve(
    getRootDir(),
    'client',
    'platforms',
    'android'
  );
  const keystorePath = path.resolve(androidBuildPath, 'keystore.p12');

  await fs.writeFile(keystorePath, Buffer.from(ksContents, 'base64'));

  await cordova.compile({
    verbose,
    platforms: ['android'],
    options: {
      release: true,
      argv: [
        // Path is relative to /platforms/android/.
        // See https://docs.gradle.org/current/userguide/composite_builds.html#command_line_composite
        '--gradleArg=--include-build=../../src/cordova/android/OutlineAndroidLib',
        verbose ? '--gradleArg=--info' : '--gradleArg=--quiet',
        `--keystore=${keystorePath}`,
        '--alias=privatekey',
        `--storePassword=${ksPassword}`,
        `--password=${ksPassword}`,
        '--',
        '--gradleArg=-PcdvBuildMultipleApks=true',
      ],
    },
  });

  return buildUniversalApkSet({
    bundlePath: path.resolve(
      androidBuildPath,
      'app',
      'build',
      'outputs',
      'bundle',
      'release',
      'app-release.aab'
    ),
    outputDir: androidBuildPath,
    keystorePath,
    ksPassword,
    javaPath,
  });
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
