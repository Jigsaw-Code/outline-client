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

package netconfig

import (
	"strconv"

	"localhost/client/go/composer"
)

// scalarNode synthesizes a scalar composer.Node from a Go string, so a
// parser can delegate a derived value (e.g. a default endpoint address)
// through another parser.
func scalarNode(s string) (composer.Node, error) {
	return composer.ParseYAML([]byte(strconv.Quote(s)))
}
