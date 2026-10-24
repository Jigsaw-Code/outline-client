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

import path from 'path';
import url from 'url';

import {getRootDir} from '@outline/infrastructure/build/get_root_dir.mjs';
import {runAction} from '@outline/infrastructure/build/run_action.mjs';
import {spawnStream} from '@outline/infrastructure/build/spawn_stream.mjs';
import electron from 'electron';

import {stageRuntimeAssets} from './stage_runtime_assets.mjs';
import {getBuildParameters} from '../build/get_build_parameters.mjs';

/**
 * @description Builds and starts the electron application.
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  // getBuildParameters enforces that --arch is set for linux/windows, so by
  // the time we forward it to `client/electron/build` we know it's valid.
  const {platform, buildMode, arch} = getBuildParameters(parameters);

  await runAction(
    'client/web/build',
    platform,
    `--buildMode=${buildMode}`,
    `--arch=${arch}`
  );
  await runAction('client/electron/build_main', ...parameters);
  await runAction(
    'client/electron/build',
    platform,
    `--buildMode=${buildMode}`,
    `--arch=${arch}`
  );

  const appPath = path.join(getRootDir(), 'output', 'client', 'electron');
  await stageRuntimeAssets(appPath);

  process.env.OUTLINE_DEBUG = buildMode === 'debug';

  await spawnStream(electron, appPath);
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
