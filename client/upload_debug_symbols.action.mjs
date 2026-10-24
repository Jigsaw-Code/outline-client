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

import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import {getRootDir} from '@outline/infrastructure/build/get_root_dir.mjs';
import {spawnStream} from '@outline/infrastructure/build/spawn_stream.mjs';

import {getBuildParameters} from './build/get_build_parameters.mjs';

// Sentry destination. Authentication is handled by sentry-cli itself: it reads
// a token from `sentry-cli login` (~/.sentryclirc) or from SENTRY_AUTH_TOKEN if
// set, so no credential is ever passed in argv or handled here.
const DEFAULT_SENTRY_ORG = 'outlinevpn';
const DEFAULT_SENTRY_PROJECT = 'outline-clients';

// Temp directories created while collecting debug files (e.g. the Android .aar
// extraction). They must outlive the upload, so main() removes them on exit.
const tempDirs = [];

/**
 * Resolve the sentry-cli binary. Prefer the path exported by the @sentry/cli
 * package so this works whether or not node_modules/.bin is on PATH; fall back
 * to the PATH lookup used by `npm run action`.
 * @returns {string}
 */
function resolveSentryCli() {
  try {
    const require = createRequire(import.meta.url);
    const {getPath} = require('@sentry/cli/js/helper');
    const resolved = getPath();
    if (resolved) {
      return resolved;
    }
  } catch {
    // Fall through to the PATH lookup.
  }
  return 'sentry-cli';
}

/**
 * Uploads native debug information files (DIFs) for a release build to Sentry so
 * native crashes (e.g. in libgojni.so) can be symbolicated. Only runs for
 * release builds; it is invoked explicitly by the release pipeline, not from
 * inside a build, so local and debug builds never reach it. sentry-cli supplies
 * the credentials (see the note by DEFAULT_SENTRY_ORG).
 *
 * @param {string[]} parameters The list of action arguments passed in.
 */
export async function main(...parameters) {
  const {platform, buildMode, goArch} = getBuildParameters(parameters);

  if (buildMode !== 'release') {
    console.debug(
      `[sentry] Skipping native debug symbol upload for ${platform} (${buildMode} build).`
    );
    return;
  }

  try {
    const debugFiles = await collectDebugFiles(platform, goArch);
    if (debugFiles === null) {
      console.warn(
        '[sentry] Native debug symbol upload is not implemented for platform ' +
          `"${platform}"; skipping.`
      );
      return;
    }
    if (debugFiles.length === 0) {
      throw new Error(
        `[sentry] No native debug files were found for ${platform}. Expected at ` +
          'least one binary with DWARF. Was the release build run first?'
      );
    }

    // Verify every file actually carries usable debug info BEFORE uploading. A
    // stripped binary uploads "successfully" but resolves nothing, so we fail the
    // build here rather than ship a symbol pipeline that silently does nothing.
    // dSYM bundles are directories; check the DWARF binaries inside them.
    for (const file of debugFiles) {
      for (const target of await resolveCheckTargets(file)) {
        await assertUsableDebugFile(target);
      }
    }

    const org = process.env.SENTRY_ORG || DEFAULT_SENTRY_ORG;
    const project = process.env.SENTRY_PROJECT || DEFAULT_SENTRY_PROJECT;

    await spawnStream(
      resolveSentryCli(),
      'debug-files',
      'upload',
      '--org',
      org,
      '--project',
      project,
      // Bundle the referenced native sources so Sentry can show source context in
      // native stack frames (the analog of the Gradle plugin's
      // includeNativeSources = true).
      '--include-sources',
      ...debugFiles
    );

    console.info(
      `[sentry] Uploaded ${debugFiles.length} native debug file(s) for ` +
        `${platform} to ${org}/${project}.`
    );
  } finally {
    await Promise.all(
      tempDirs.splice(0).map(dir => fs.rm(dir, {recursive: true, force: true}))
    );
  }
}

/**
 * Returns the list of native debug files to upload for the given platform, or
 * null if symbol upload is not implemented for it.
 * @param {string} platform
 * @param {string | undefined} goArch
 * @returns {Promise<string[] | null>}
 */
async function collectDebugFiles(platform, goArch) {
  switch (platform) {
    case 'android':
      return collectAndroidDebugFiles();
    case 'linux':
    case 'windows':
      return collectElectronDebugFiles(platform, goArch);
    case 'ios':
      return collectAppleDebugFiles(platform);
    default:
      return null;
  }
}

/**
 * Extracts the unstripped per-ABI .so files from the tun2socks .aar produced by
 * `go tool task client:tun2socks:android` into a temp directory and returns
 * their paths. The .aar is the only place the .so exists after gomobile bind;
 * the Android Gradle Plugin strips the copy it packages into the APK, so the
 * .so inside this .aar is the unstripped one we want to upload.
 * @returns {Promise<string[]>}
 */
async function collectAndroidDebugFiles() {
  const aar = path.resolve(
    getRootDir(),
    'output/client/android/org/getoutline/client/tun2socks/0.0.1/tun2socks-0.0.1.aar'
  );
  try {
    await fs.access(aar);
  } catch {
    throw new Error(
      `[sentry] Expected tun2socks .aar not found at ${aar}. Build the Android ` +
        'client (release) before uploading debug symbols.'
    );
  }

  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'outline-android-syms-')
  );
  tempDirs.push(outDir);
  // The .aar is a zip; jni/<abi>/libgojni.so holds the native code. Preserve the
  // jni/<abi>/ layout so same-named .so files across ABIs don't collide.
  await spawnStream('unzip', '-o', '-q', aar, 'jni/*', '-d', outDir);

  const jniDir = path.join(outDir, 'jni');
  const files = [];
  for (const abi of await fs.readdir(jniDir)) {
    const abiDir = path.join(jniDir, abi);
    for (const entry of await fs.readdir(abiDir)) {
      if (entry.endsWith('.so')) {
        files.push(path.join(abiDir, entry));
      }
    }
  }
  return files;
}

/**
 * Returns the Go-built native artifacts for a desktop (Electron) build: the
 * backend shared library and the tun2socks binary, from
 * output/client/<platform>-<goArch>/. These are shipped unstripped (see the
 * Taskfile electron task), so the copies on disk carry the DWARF we upload.
 * @param {string} platform 'linux' | 'windows'
 * @param {string | undefined} goArch
 * @returns {Promise<string[]>}
 */
async function collectElectronDebugFiles(platform, goArch) {
  if (!goArch) {
    throw new Error(
      `[sentry] --arch is required to locate ${platform} debug files.`
    );
  }
  const binaryDir = path.resolve(
    getRootDir(),
    'output',
    'client',
    `${platform}-${goArch}`
  );
  const candidates =
    platform === 'windows'
      ? ['backend.dll', 'tun2socks.exe']
      : ['libbackend.so', 'tun2socks'];

  const files = [];
  for (const name of candidates) {
    const candidate = path.join(binaryDir, name);
    try {
      await fs.access(candidate);
      files.push(candidate);
    } catch {
      // The binary for this platform/arch wasn't produced; skip it.
    }
  }
  return files;
}

/**
 * Returns the .dSYM bundles for an Apple build. The caller passes the archive
 * location via SENTRY_DSYMS_PATH — either the .xcarchive itself (the Capacitor
 * iOS release leaves it at output/client/ios/Outline.xcarchive) or its dSYMs
 * directory. This is invoked from the release script, which already resolves
 * the archive path.
 * @param {string} platform 'ios'
 * @returns {Promise<string[]>}
 */
async function collectAppleDebugFiles(platform) {
  const provided = process.env.SENTRY_DSYMS_PATH;
  if (!provided) {
    throw new Error(
      `[sentry] SENTRY_DSYMS_PATH must point at the ${platform} .xcarchive (or ` +
        'its dSYMs directory) to upload Apple debug symbols. The release script ' +
        'sets this after locating the archive.'
    );
  }
  const dsymsDir = provided.endsWith('.xcarchive')
    ? path.join(provided, 'dSYMs')
    : provided;
  try {
    await fs.access(dsymsDir);
  } catch {
    throw new Error(`[sentry] dSYMs directory not found at ${dsymsDir}.`);
  }

  const files = [];
  for (const entry of await fs.readdir(dsymsDir)) {
    if (entry.endsWith('.dSYM')) {
      files.push(path.join(dsymsDir, entry));
    }
  }
  return files;
}

/**
 * Expands a debug-file path into the concrete object files to run
 * `debug-files check` on. A .dSYM is a bundle directory; its DWARF lives at
 * Contents/Resources/DWARF/<binary>. Everything else is checked as-is.
 * @param {string} file
 * @returns {Promise<string[]>}
 */
async function resolveCheckTargets(file) {
  if (!file.endsWith('.dSYM')) {
    return [file];
  }
  const dwarfDir = path.join(file, 'Contents', 'Resources', 'DWARF');
  let entries;
  try {
    entries = await fs.readdir(dwarfDir);
  } catch {
    throw new Error(
      `[sentry] ${path.basename(file)} has no DWARF payload at ${dwarfDir}; ` +
        'the archive was likely built without debug information.'
    );
  }
  return entries.map(entry => path.join(dwarfDir, entry));
}

/**
 * Runs `sentry-cli debug-files check` on a file and throws unless it reports
 * usable debug info that includes DWARF (`debug`). This is the guard the task
 * explicitly asked for: uploading a stripped binary silently produces nothing
 * useful. Unwind tables are strongly desired but their presence varies by
 * object format, so a missing one is a warning rather than a build failure.
 * @param {string} file
 * @returns {Promise<void>}
 */
async function assertUsableDebugFile(file) {
  const output = await spawnStream(
    resolveSentryCli(),
    'debug-files',
    'check',
    file
  );

  // Parse the feature list from the "Contained debug information:" section
  // specifically, e.g. "  Contained debug information:\n    > symtab, debug,
  // unwind". Matching the whole output would falsely pass a DWARF-stripped
  // binary, because the words "debug" ("Debug ID", "Contained debug
  // information") appear regardless of whether DWARF is actually present.
  const featuresMatch = output.match(
    /Contained debug information:\s*>\s*([^\n]+)/i
  );
  const features = (featuresMatch?.[1] ?? '').toLowerCase();

  const usable = /usable:\s*yes/i.test(output);
  const hasDebug = /\bdebug\b/.test(features);
  const hasUnwind = /\bunwind\b/.test(features);

  // DWARF (`debug`) is the hard requirement: without it a stripped binary
  // symbolicates nothing, which is exactly what we're guarding against. Unwind
  // tables are strongly desired but their presence varies by object format, so
  // a missing one is a warning rather than a build failure.
  if (!usable || !hasDebug) {
    throw new Error(
      `[sentry] ${path.basename(file)} is missing usable native debug info ` +
        `(usable=${usable}, debug=${hasDebug}, unwind=${hasUnwind}). It was ` +
        "likely stripped at build time (e.g. gomobile -ldflags='-s -w'). " +
        'Refusing to upload a binary that would symbolicate nothing.\n' +
        `sentry-cli debug-files check output:\n${output}`
    );
  }

  if (!hasUnwind) {
    console.warn(
      `[sentry] ${path.basename(file)}: DWARF present but no unwind tables ` +
        'reported; stack unwinding through this frame may be incomplete.'
    );
  }

  console.info(
    `[sentry] ${path.basename(file)}: usable native debug info confirmed ` +
      `(debug present${hasUnwind ? ', unwind present' : ''}).`
  );
}

if (
  process.argv[1] &&
  import.meta.url === url.pathToFileURL(process.argv[1]).href
) {
  await main(...process.argv.slice(2));
}
