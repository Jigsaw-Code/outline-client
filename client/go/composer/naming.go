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

package composer

import "strings"

// normalizeKey returns the form used to match config keys against Go
// field names: lowercase with underscores removed. "server_port",
// "ServerPort" and "serverport" all normalize identically. Because
// matching is normalization-based, the normalized form is itself a
// valid wire spelling of the field, which is why error messages can
// use it directly.
func normalizeKey(key string) string {
	return strings.ToLower(strings.ReplaceAll(key, "_", ""))
}
