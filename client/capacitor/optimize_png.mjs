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

import sharp from 'sharp';

/**
 * Losslessly recompresses every PNG under the given paths, in place.
 *
 * The pixels are left untouched: the file is re-encoded with the slowest
 * zlib setting and adaptive filtering, which typically halves the size of
 * the PNGs that design tools and `capacitor-assets` write. A file is only
 * replaced when the result is smaller, so running this repeatedly is a no-op.
 *
 * Usage: node optimize_png.mjs <file-or-directory>...
 */

async function* findPngs(target) {
  const stats = await fs.stat(target);
  if (stats.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      if (entry === 'node_modules') continue;
      yield* findPngs(path.join(target, entry));
    }
  } else if (target.toLowerCase().endsWith('.png')) {
    yield target;
  }
}

export async function optimizePng(file) {
  const original = await fs.readFile(file);
  const optimized = await sharp(original)
    .png({compressionLevel: 9, adaptiveFiltering: true, effort: 10})
    .toBuffer();
  if (optimized.length >= original.length) {
    return {file, before: original.length, after: original.length};
  }
  await fs.writeFile(file, optimized);
  return {file, before: original.length, after: optimized.length};
}

export async function main(...targets) {
  if (targets.length === 0) {
    throw new TypeError('Usage: node optimize_png.mjs <file-or-directory>...');
  }
  let before = 0;
  let after = 0;
  for (const target of targets) {
    for await (const file of findPngs(target)) {
      const result = await optimizePng(file);
      before += result.before;
      after += result.after;
      if (result.after < result.before) {
        console.log(
          `${result.file}: ${result.before} -> ${result.after} bytes`
        );
      }
    }
  }
  console.log(`Total: ${before} -> ${after} bytes`);
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
