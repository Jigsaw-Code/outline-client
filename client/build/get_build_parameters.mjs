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

import minimist from 'minimist';

const VALID_PLATFORMS = ['linux', 'windows', 'ios', 'android', 'browser'];
const VALID_BUILD_MODES = ['debug', 'release'];

// Every (platform, arch) combination we support building. Acts as the single
// source of truth for arch validation and for the goArch translation we need
// downstream (Taskfile and `output/client/<platform>-<goArch>` directories use
// Go arch names; --arch and electron-builder use electron-builder names).
export const SUPPORTED_BUILDS = [
  {platform: 'linux', arch: 'x64', goArch: 'amd64'},
  {platform: 'linux', arch: 'arm64', goArch: 'arm64'},
  {platform: 'windows', arch: 'ia32', goArch: '386'},
  {platform: 'windows', arch: 'arm64', goArch: 'arm64'},
];

const BUILDS_BY_PLATFORM = Map.groupBy(SUPPORTED_BUILDS, b => b.platform);

const MS_PER_HOUR = 1000 * 60 * 60;

function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(
      `${label} "${value}" is not valid. Must be one of ${allowed.join(', ')}.`
    );
  }
}

// Returns the matching SUPPORTED_BUILDS row, or null when the platform doesn't
// take --arch. Throws if --arch is required and missing/invalid, or if --arch
// is given for a platform that doesn't take it.
function resolveBuild(platform, arch) {
  const builds = BUILDS_BY_PLATFORM.get(platform);
  if (!builds) {
    if (arch) {
      throw new TypeError(
        `--arch cannot be specified for platform "${platform}".`
      );
    }
    return null;
  }
  const match = arch ? builds.find(b => b.arch === arch) : null;
  if (match) return match;
  const validArchs = builds.map(b => b.arch).join(', ');
  throw new TypeError(
    arch
      ? `Architecture "${arch}" is not a valid target for ${platform}. Must be one of ${validArchs}.`
      : `--arch is required for platform "${platform}". Must be one of ${validArchs}.`
  );
}

/*
  Inputs:
  => cliParameters: the list of action arguments passed in

  Outputs:
  => an object containing the specificed platform and buildMode.
*/
export function getBuildParameters(cliArguments) {
  const {
    _: [platform = 'browser'],
    buildMode = 'debug',
    verbose = false,
    versionName = '0.0.0',
    sentryDsn = process.env.SENTRY_DSN,
    arch = '',
    // The build number identifies one build across everything that makes it
    // up (the web bundle, the native app). An action that builds several of
    // them parses it once and passes the value on, so that they all agree
    // even when the build crosses an hour boundary.
    buildNumber = Math.floor(Date.now() / MS_PER_HOUR),
  } = minimist(cliArguments);

  assertOneOf(platform, VALID_PLATFORMS, 'Platform');
  assertOneOf(buildMode, VALID_BUILD_MODES, 'Build mode');
  if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
    throw new TypeError(
      `Build number "${buildNumber}" is not valid. Must be a positive integer.`
    );
  }
  const build = resolveBuild(platform, arch);

  return {
    platform,
    buildMode,
    verbose,
    versionName:
      buildMode === 'release' ? versionName : `${versionName}-${buildMode}`,
    sentryDsn,
    buildNumber,
    arch,
    goArch: build?.goArch,
    // The Taskfile parameterizes linux/windows tasks by arch
    // (`linux:amd64`, `windows:386`, ...); android/apple/browser are single
    // tasks. Resolve the shape here so callers don't conditional on it.
    goTaskTarget: build ? `${platform}:${build.goArch}` : platform,
  };
}
