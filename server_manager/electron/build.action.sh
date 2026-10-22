#!/bin/bash -eu
#
# Copyright 2018 The Outline Authors
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

# Electron app root folder
readonly STATIC_DIR="${BUILD_DIR}/server_manager/electron/static"
rm -rf "${STATIC_DIR}"
mkdir -p "${STATIC_DIR}"

VERSION_NAME='0.0.0-debug'
BUILD_MODE=debug
for i in "$@"; do
  case ${i} in
  --buildMode=*)
    BUILD_MODE="${i#*=}"
    shift
    ;;
  --versionName=*)
    VERSION_NAME="${i#*=}"
    shift
    ;;
  --* | -*)
    echo "Unknown option: ${i}"
    exit 1
    ;;
  *) ;;
  esac
done

if [[ -z "${WEBPACK_MODE:-}" ]]; then
  case "${BUILD_MODE}" in
    release)
      export WEBPACK_MODE="production";;
    *)
      export WEBPACK_MODE="development";;
  esac
fi

# Build the Web App.
node infrastructure/build/run_action.mjs server_manager/www/build

# Compile the Electron main process and preload to the app root folder.
# Since Node.js on Cygwin doesn't like absolute Unix-style paths,
# we'll use relative paths here.
webpack --config=server_manager/electron_main.webpack.mjs ${WEBPACK_MODE:+--mode=${WEBPACK_MODE}}
webpack --config=server_manager/electron_preload.webpack.mjs ${WEBPACK_MODE:+--mode=${WEBPACK_MODE}}

# Assemble everything together.
mkdir -p "${STATIC_DIR}/server_manager"
cp -r "${BUILD_DIR}/server_manager/www/static" "${STATIC_DIR}/server_manager/www/"

# Electron requires a package.json file for the app's name, etc.
# We also need to install NPMs at this location for require()
# in order for require() to work right in the renderer process, which
# is loaded via a custom protocol.
cp package-lock.json "${STATIC_DIR}"
sed "s/0.0.0-debug/${VERSION_NAME}/g" server_manager/package.json > "${STATIC_DIR}/package.json"
cd "${STATIC_DIR}"

# Icons.
cd "${ROOT_DIR}"
cp -r server_manager/electron/icons/ "${BUILD_DIR}/server_manager/electron/static/icons/"
