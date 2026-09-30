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

export async function writeEnvironmentJson(
  capacitorDir,
  versionName,
  buildNumber,
  sentryDsn
) {
  const outputPath = path.resolve(capacitorDir, 'www', 'environment.json');
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        SENTRY_DSN: sentryDsn,
        APP_VERSION: versionName,
        APP_BUILD_NUMBER: String(buildNumber),
      },
      null,
      2
    )
  );
}
