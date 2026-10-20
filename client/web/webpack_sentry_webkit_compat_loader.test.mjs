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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';

import loader from './webpack_sentry_webkit_compat_loader.cjs';

const require = createRequire(import.meta.url);
const sentryDir = path.dirname(require.resolve('@sentry/core/package.json'));

for (const format of ['esm', 'cjs']) {
  test(`preserves the ${format} Sentry SQL sanitizer without lookbehind`, () => {
    const source = fs.readFileSync(
      path.join(sentryDir, 'build', format, 'integrations', 'postgresjs.js'),
      'utf8'
    );
    const transformed = loader(source);
    assert.notEqual(
      transformed,
      source,
      'Revisit the workaround if Sentry changes its sanitizer'
    );
    assert.ok(!transformed.includes('(?<!'));
    assert.equal(loader(transformed), transformed);

    // Exercise the actual dependency's entire sanitizer, including neighboring
    // replacements, rather than a copy of the regular expression alone.
    const getSanitizer = moduleSource => {
      const start = moduleSource.indexOf('function _sanitizeSqlQuery(');
      assert.ok(start >= 0);
      const end = moduleSource.indexOf('\n}\n', start) + 2;
      return new Function(
        `${moduleSource.slice(start, end)}; return _sanitizeSqlQuery;`
      )();
    };
    const originalSanitize = getSanitizer(source);
    const compatibleSanitize = getSanitizer(transformed);
    const compare = input => {
      assert.equal(
        compatibleSanitize(input),
        originalSanitize(input),
        JSON.stringify(input)
      );
    };
    for (const input of [
      '',
      'SELECT * FROM t WHERE id = $1 AND n = -42',
      'SELECT $1, $12, $-123, 12, -12, 1.5, -.5, 2e-3',
      "SELECT '123', TRUE, X'AB', B'01', 0xFF -- comment 123\nFROM t;",
      'SELECT * FROM t WHERE id IN ($1, $2) AND n IN (1, 2, 3)',
    ]) {
      compare(input);
    }
    // Covers adjacent matches, word boundaries and $-prefixed negative numbers.
    const alphabet = '$- 01a,';
    const visit = (prefix, remaining) => {
      compare(prefix);
      if (remaining > 0) {
        for (const character of alphabet) {
          visit(prefix + character, remaining - 1);
        }
      }
    };
    visit('', 6);
  });
}

test('leaves unrelated source unchanged', () => {
  const source = 'const value = "$1";';
  assert.equal(loader(source), source);
});
