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

# Same as package, except:
#  - prod Sentry keys are used
#  - auto-updates are configured

yarn do src/electron/package_common

scripts/environment_json.sh -r -p linux > www/environment.json

readonly S3_URL=https://s3.amazonaws.com/${OUTLINE_RELEASE_BUCKET:-outline-releases}/client
echo "Updates fetched from ${S3_URL}"

# Publishing is disabled, updates are pulled from AWS. We use the generic provider instead of the S3
# provider since the S3 provider uses "virtual-hosted style" URLs (my-bucket.s3.amazonaws.com)
# which can be blocked by DNS or SNI without taking down other buckets.
electron-builder \
  --linux \
  --publish never \
  --config src/electron/electron-builder.json \
  --config.extraMetadata.version=$(scripts/semantic_version.sh -p linux) \
  --config.publish.provider=generic \
  --config.publish.url=${S3_URL}
