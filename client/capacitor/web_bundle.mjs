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

import fs from 'fs/promises';
import path from 'path';
import url from 'url';

import webpackConfig from './webpack.config.js';
import {writeEnvironmentJson} from './write_environment.mjs';
import {getWebpackBuildMode} from '../build/get_webpack_build_mode.mjs';
import {runWebpack} from '../build/run_webpack.mjs';

const capacitorDir = path.dirname(url.fileURLToPath(import.meta.url));

const SUPPORTED_PLATFORMS = new Set(['browser', 'android', 'ios']);

/**
 * Builds the Capacitor web bundle into client/capacitor/www/. Takes the
 * already-parsed build parameters (see client/build/get_build_parameters.mjs),
 * so that an action which also builds the native app can pass it the same
 * version and build number it uses itself.
 *
 * @param {object} parameters
 * @param {string} parameters.platform
 * @param {string} parameters.buildMode
 * @param {string} parameters.versionName
 * @param {number} parameters.buildNumber
 * @param {string | undefined} parameters.sentryDsn
 */
export async function buildWebBundle({
  platform,
  buildMode,
  versionName,
  buildNumber,
  sentryDsn,
}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new TypeError(
      `The Capacitor web bundle supports platforms ${[...SUPPORTED_PLATFORMS].join(', ')}, got "${platform}".`
    );
  }

  if (buildMode === 'release') {
    if (versionName === '0.0.0') {
      throw new TypeError(
        'Release builds require a valid versionName, but it is set to 0.0.0.'
      );
    }

    if (!sentryDsn) {
      throw new TypeError(
        'Release builds require SENTRY_DSN, but it is not defined.'
      );
    }

    try {
      new URL(sentryDsn);
    } catch {
      throw new TypeError(`The sentryDsn ${sentryDsn} is not a valid URL!`);
    }
  }

  const outputDir = path.resolve(capacitorDir, 'www');
  await fs.rm(outputDir, {recursive: true, force: true});
  await fs.mkdir(outputDir, {recursive: true});

  await writeEnvironmentJson(capacitorDir, versionName, buildNumber, sentryDsn);
  await runWebpack({
    ...webpackConfig,
    mode: getWebpackBuildMode(buildMode),
    // emit source maps only for debug builds.
    devtool: buildMode === 'debug' ? 'source-map' : false,
  });
}
