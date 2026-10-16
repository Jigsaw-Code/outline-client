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

import "testing"

func FuzzParseAndDecode(f *testing.F) {
	f.Add("a: 1")
	f.Add("$type: x\nlist: [1, {b: c}]\nk?: v")
	f.Add("x: &a [*b]\nb: &b 1")
	f.Add("a: &m\n  <<: *m")
	f.Fuzz(func(t *testing.T, text string) {
		node, err := ParseYAML([]byte(text))
		if err != nil {
			return
		}
		var out map[string]Node
		_ = node.Decode(&out) // must not panic or hang
	})
}
