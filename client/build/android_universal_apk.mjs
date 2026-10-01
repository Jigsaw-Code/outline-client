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

// Build tooling shared by the Cordova (client/src/cordova/build.action.mjs)
// and Capacitor (client/capacitor/build.action.mjs) Android release builds.
// It lives here only while both exist: once the Cordova client is deleted,
// merge it back into the Capacitor build.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {downloadHttpsFile} from '@outline/infrastructure/build/download_file.mjs';
import {spawnStream} from '@outline/infrastructure/build/spawn_stream.mjs';

// bundletool turns the release AAB into the installable universal APK we ship
// to S3 (an AAB itself cannot be installed). We need a modern version: since
// bundletool 1.17.0 it 16 KB-page-aligns the uncompressed native libraries in
// the generated APK ("Default page size is now set to 16 KB"), which Android
// 15+ and the Play Store require; the previously pinned 1.8.2 aligned them to
// 4 KB. https://github.com/google/bundletool/releases/tag/1.17.0
const JAVA_BUNDLETOOL_VERSION = '1.18.3';
const JAVA_BUNDLETOOL_RESOURCE_URL = `https://github.com/google/bundletool/releases/download/${JAVA_BUNDLETOOL_VERSION}/bundletool-all-${JAVA_BUNDLETOOL_VERSION}.jar`;

/**
 * Verifies that the native libraries in an APK are aligned for 16 KB memory
 * pages, as required by Android 15+ and the Play Store. Throws (failing the
 * build) if any `.so` is misaligned, so a bundletool/packaging regression can
 * never ship silently again.
 *
 * @param {string} apkPath path to the APK to check.
 */
async function verify16kAlignment(apkPath) {
  const androidHome = process.env.ANDROID_HOME;
  if (!androidHome) {
    throw new ReferenceError(
      'ANDROID_HOME must be defined in the environment to verify APK alignment!'
    );
  }

  // zipalign lives in the build-tools; pick the newest installed version.
  const buildToolsDir = path.resolve(androidHome, 'build-tools');
  const buildToolsVersions = (await fs.readdir(buildToolsDir))
    .filter(name => /^\d+\./.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
  if (buildToolsVersions.length === 0) {
    throw new ReferenceError(
      `No Android build-tools found under ${buildToolsDir} to run zipalign!`
    );
  }
  const zipalignPath = path.resolve(
    buildToolsDir,
    buildToolsVersions.at(-1),
    'zipalign'
  );

  // `-c` checks (does not modify), `-P 16` requires 16 KB page alignment for
  // shared libraries, `4` is the alignment for all other entries, `-v` is
  // verbose. zipalign exits non-zero (making spawnStream throw) if misaligned.
  await spawnStream(zipalignPath, '-c', '-P', '16', '-v', '4', apkPath);
}

/**
 * Builds the signed universal APK from a signed release AAB with bundletool,
 * and verifies that it is 16 KB aligned. Leaves `universal.apk` in the output
 * directory, along with `Outline.zip`, the bundletool `.apks` archive it was
 * extracted from.
 *
 * @param {object} options
 * @param {string} options.bundlePath path to the release AAB.
 * @param {string} options.outputDir directory that receives `universal.apk`
 *   and `Outline.zip` (and the downloaded bundletool.jar).
 * @param {string} options.keystorePath path to the PKCS#12 signing keystore.
 * @param {string} options.ksPassword password of the keystore and its key.
 * @param {string} options.javaPath the JAVA_HOME of the JDK that runs bundletool.
 */
export async function buildUniversalApkSet({
  bundlePath,
  outputDir,
  keystorePath,
  ksPassword,
  javaPath,
}) {
  const bundletoolPath = path.resolve(outputDir, 'bundletool.jar');
  await downloadHttpsFile(JAVA_BUNDLETOOL_RESOURCE_URL, bundletoolPath);

  const outputPath = path.resolve(outputDir, 'Outline.apks');

  // Pass the keystore password through a file rather than `pass:<password>`:
  // spawnStream echoes the full command line, and argv is visible to other
  // processes via `ps`. bundletool reads only the first line of the file.
  if (/[\r\n]/.test(ksPassword)) {
    throw new TypeError(
      'ANDROID_KEY_STORE_PASSWORD must not contain newline characters!'
    );
  }

  // A unique 0700 temp directory per invocation, so concurrent builds
  // cannot overwrite or delete each other's password file.
  const ksPasswordDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'outline-android-signing-')
  );
  const ksPasswordPath = path.join(ksPasswordDir, 'keystore.pass');

  try {
    await fs.writeFile(ksPasswordPath, ksPassword, {mode: 0o600});

    await spawnStream(
      path.resolve(javaPath, 'bin', 'java'),
      '-jar',
      bundletoolPath,
      'build-apks',
      `--bundle=${bundlePath}`,
      `--output=${outputPath}`,
      '--mode=universal',
      `--ks=${keystorePath}`,
      `--ks-pass=file:${ksPasswordPath}`,
      '--ks-key-alias=privatekey',
      `--key-pass=file:${ksPasswordPath}`
    );
  } finally {
    await fs.rm(ksPasswordDir, {recursive: true, force: true});
  }

  // The universal `.apks` archive is a zip holding `universal.apk`. Extract it
  // next to the bundle, and assert its native libraries are 16 KB aligned
  // before we ship it.
  await spawnStream(
    'unzip',
    '-o',
    outputPath,
    'universal.apk',
    '-d',
    outputDir
  );
  await verify16kAlignment(path.resolve(outputDir, 'universal.apk'));

  return fs.rename(outputPath, path.resolve(outputDir, 'Outline.zip'));
}
