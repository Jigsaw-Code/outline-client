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

import url from 'url';

import {buildWebBundle} from './web_bundle.mjs';
import {getBuildParameters} from '../build/get_build_parameters.mjs';

/**
 * @description Builds the Capacitor web bundle (client/capacitor/www/).
 *
 * @param {string[]} parameters
 */
export async function main(...parameters) {
  await buildWebBundle(getBuildParameters(parameters));
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
