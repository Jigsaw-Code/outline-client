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

import {getRootDir} from '@outline/infrastructure/build/get_root_dir.mjs';

// Runtime assets that the main process loads via `app.getAppPath()` and that
// `electron-builder` bundles into packaged builds (see `electron-builder.json`
// `files`). Launching Electron directly against `output/client/electron`
// bypasses electron-builder, so callers mirror these directories into the
// launched app path themselves. Without this, code such as the tray icon
// loader throws `cannot find <name>.png tray icon image`.
const RUNTIME_ASSET_DIRS = [
  path.join('client', 'resources', 'tray'),
  path.join('client', 'www'),
  path.join('client', 'electron', 'icons'),
];

/**
 * Mirrors directories listed in {@link RUNTIME_ASSET_DIRS} from the repo root
 * into the launched Electron app path so `app.getAppPath()`-relative lookups
 * resolve the same way they would in a packaged build.
 *
 * @param {string} appPath Absolute path to the directory passed to Electron.
 */
export async function stageRuntimeAssets(appPath) {
  for (const relativeDir of RUNTIME_ASSET_DIRS) {
    const source = path.join(getRootDir(), relativeDir);
    const destination = path.join(appPath, relativeDir);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.cp(source, destination, {recursive: true});
  }
}
