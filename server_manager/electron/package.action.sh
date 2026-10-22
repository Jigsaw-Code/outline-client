#!/bin/bash -eu
#
# Copyright 2024 The Outline Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
set -eu

SCRIPT_DIR="$(dirname "$0")"
PROJECT_DIR="${BUILD_DIR}/server_manager/electron/static"
BUILD_MODE=debug
PLATFORM=

function package_electron() {
  declare -a electron_builder_cmd=(
    electron-builder
    --projectDir="${PROJECT_DIR}"
    --config="${SCRIPT_DIR}/electron_builder.json"
    --publish=never
  )

  case "${PLATFORM}" in
    linux)
      electron_builder_cmd+=(--linux);;
    windows)
      electron_builder_cmd+=(--win --ia32 --arm64);;
    macos)
      electron_builder_cmd+=(--mac);;
    *)
      echo "Unsupported platform ${PLATFORM}" >&2 && exit 1
  esac

  if [[ "${BUILD_MODE}" == "release" ]]; then
    electron_builder_cmd+=(
      --config.generateUpdatesFilesForAllChannels=true
      --config.publish.provider=generic
      --config.publish.url=https://s3.amazonaws.com/outline-releases/manager/
    )
  fi

  "${electron_builder_cmd[@]}"
}

function finish_yaml_files() {
  declare -r staging_percentage="${1?Staging percentage missing}"

  # electron-builder names its auto-update manifests with a platform-specific
  # suffix that is NOT the same as our PLATFORM value, and on Linux it also
  # writes a separate manifest for each non-x64 architecture:
  #   linux   -> latest-linux.yml, latest-linux-arm64.yml
  #   windows -> latest.yml  (no suffix; the combined installer covers all archs)
  #   macos   -> latest-mac.yml
  local -a yaml_suffixes
  case "${PLATFORM}" in
    linux) yaml_suffixes=('-linux' '-linux-arm64');;
    windows) yaml_suffixes=('');;
    macos) yaml_suffixes=('-mac');;
    *) echo "Unsupported platform ${PLATFORM}" >&2 && exit 1;;
  esac

  local release_channel
  release_channel=$(node_modules/node-jq/bin/jq -r '.version' server_manager/package.json | cut -s -d'-' -f2)
  # If this isn't an alpha or beta build, `cut -s` will return an empty string
  if [[ -z "${release_channel}" ]]; then
    release_channel=latest
  fi

  local yaml_suffix
  for yaml_suffix in "${yaml_suffixes[@]}"; do
    echo "stagingPercentage: ${staging_percentage}" >> "${PROJECT_DIR}/dist/${release_channel}${yaml_suffix}.yml"

    # If we cut a staged mainline release, beta testers will take the update as well.
    if [[ "${release_channel}" == "latest" ]]; then
      echo "stagingPercentage: ${staging_percentage}" >> "${PROJECT_DIR}/dist/beta${yaml_suffix}.yml"
    fi

    # We don't support alpha releases
    rm -f "${PROJECT_DIR}/dist/alpha${yaml_suffix}.yml"
  done
}

function main() {
  declare staging_percentage=100
  declare version_name='0.0.0-debug'

  PLATFORM="${1?Platform missing}"

  for i in "$@"; do
    case "${i}" in
    --buildMode=*)
      BUILD_MODE="${i#*=}"
      shift
      ;;
    --versionName=*)
      version_name="${i#*=}"
      shift
      ;;
    --stagingPercentage=*)
      staging_percentage="${i#*=}"
      shift
      ;;
    --* | -*)
      echo "Unknown option: ${i}"
      exit 1
      ;;
    *) ;;
    esac
  done
  node infrastructure/build/run_action.mjs server_manager/electron/build --buildMode="${BUILD_MODE}" --versionName="${version_name}"
  package_electron
  finish_yaml_files "${staging_percentage}"
}

main "$@"
