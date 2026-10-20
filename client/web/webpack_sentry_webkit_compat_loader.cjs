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

// Temporary compatibility fix for @sentry/core 10.47.0. Babel cannot lower
// RegExp lookbehind for the older WebViews supported by the Cordova client.
// Remove this loader once Sentry ships a compatible SQL sanitizer.
// https://github.com/OutlineFoundation/outline-apps/issues/2900
const original = String.raw`.replace(/(?<!\$)-?\b\d+\b/g, '?')`;
const compatible = String.raw`.replace(/-?\b\d+\b/g, (match, offset, input) => {
  if (input.charAt(offset - 1) !== '$') {
    return '?';
  }
  // The original expression skips the minus in "$-123", then matches "123".
  return match.charAt(0) === '-' ? '-?' : match;
})`;

module.exports = function loader(source) {
  // A function replacer preserves literal dollar signs in the replacement.
  return source.replace(original, () => compatible);
};
