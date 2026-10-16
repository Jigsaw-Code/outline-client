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

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func mustParse(t *testing.T, text string) Node {
	t.Helper()
	n, err := ParseYAML([]byte(text))
	require.NoError(t, err)
	return n
}

func TestParseYAML_Kinds(t *testing.T) {
	require.Equal(t, KindMapping, mustParse(t, "a: 1").Kind())
	require.Equal(t, KindMapping, mustParse(t, "a: 1\nb: 2").Kind())
	require.Equal(t, KindSequence, mustParse(t, "- 1\n- 2").Kind())
	require.Equal(t, KindScalar, mustParse(t, `"hello"`).Kind())
	require.Equal(t, KindAbsent, mustParse(t, "").Kind())
	require.Equal(t, KindAbsent, mustParse(t, "null").Kind())
	require.True(t, Node{}.IsAbsent())
}

func TestParseYAML_Invalid(t *testing.T) {
	_, err := ParseYAML([]byte("a: [1, 2"))
	require.Error(t, err)
}

func TestNode_MappingEntries(t *testing.T) {
	n := mustParse(t, "cipher: aes\nsecret: s3cret")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	require.Len(t, entries, 2)
	require.Equal(t, "cipher", entries[0].key)
	require.Equal(t, "cipher", entries[0].value.Path())
	require.Equal(t, KindScalar, entries[0].value.Kind())

	// Single-pair mapping.
	n = mustParse(t, "only: 1")
	entries, err = n.mappingEntries()
	require.NoError(t, err)
	require.Len(t, entries, 1)

	// Not a mapping.
	_, err = mustParse(t, "- 1").mappingEntries()
	require.Error(t, err)
}

func TestNode_SequenceItems(t *testing.T) {
	n := mustParse(t, "options:\n  - a: 1\n  - b: 2")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	items, err := entries[0].value.sequenceItems()
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, "options[1]", items[1].Path())
}

func TestNode_TypeName(t *testing.T) {
	n := mustParse(t, "$type: shadowsocks\ncipher: aes")
	name, found, err := n.typeName()
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "shadowsocks", name)

	_, found, err = mustParse(t, "cipher: aes").typeName()
	require.NoError(t, err)
	require.False(t, found)

	_, _, err = mustParse(t, "$type: {bad: map}").typeName()
	require.Error(t, err)
}

func TestNode_AliasResolution(t *testing.T) {
	n := mustParse(t, "proxy: &p\n  host: example.com\nendpoint: *p")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	require.Equal(t, KindMapping, entries[0].value.Kind())
	// The alias resolves to the same mapping content.
	require.Equal(t, KindMapping, entries[1].value.Kind())
	sub, err := entries[1].value.mappingEntries()
	require.NoError(t, err)
	require.Equal(t, "host", sub[0].key)
}

func TestNode_AliasUnknown(t *testing.T) {
	n := mustParse(t, "a: *nowhere")
	_, err := n.mappingEntries()
	require.Error(t, err)
	require.Contains(t, err.Error(), "nowhere")
}

func TestNode_AliasCycles(t *testing.T) {
	// goccy rejects an anchor whose value is an alias at parse time, so
	// direct alias-to-alias chains cannot be constructed. The composer
	// maxAliasDepth guard is defense-in-depth behind this.
	_, err := ParseYAML([]byte("a: &x *x"))
	require.Error(t, err)

	// Mutually recursive anchors survive parsing; navigating any finite
	// number of levels works, and Decode's depth/visit budgets bound
	// traversal (see decode tests).
	n := mustParse(t, "a: &x\n  b: *y\nc: &y\n  d: *x")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	sub, err := entries[0].value.mappingEntries() // a -> {b: *y}
	require.NoError(t, err)
	require.Equal(t, KindMapping, sub[0].value.Kind())
}

// mergeDocExample is taken verbatim from the official access-key config
// documentation, which uses merge keys to de-duplicate config sections:
// https://developer.getoutline.org/vpn/reference/access-key-config/
const mergeDocExample = `
tcp:
  $type: shadowsocks
  endpoint: ss.example.com:80
  <<: &cipher
    cipher: chacha20-ietf-poly1305
    secret: SECRET
  prefix: "POST "

udp:
  $type: shadowsocks
  endpoint: ss.example.com:53
  <<: *cipher
`

func TestNode_MergeKeys(t *testing.T) {
	type ssConfig struct {
		Endpoint string
		Cipher   string
		Secret   string
		Prefix   Optional[string]
	}
	n := mustParse(t, mergeDocExample)
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	require.Len(t, entries, 2)

	var tcp ssConfig
	require.NoError(t, entries[0].value.Decode(&tcp))
	require.Equal(t, ssConfig{
		Endpoint: "ss.example.com:80",
		Cipher:   "chacha20-ietf-poly1305",
		Secret:   "SECRET",
		Prefix:   NewOptional("POST "),
	}, tcp)

	var udp ssConfig
	require.NoError(t, entries[1].value.Decode(&udp))
	require.Equal(t, "ss.example.com:53", udp.Endpoint)
	require.Equal(t, "chacha20-ietf-poly1305", udp.Cipher)
	require.Equal(t, "SECRET", udp.Secret)
	_, hasPrefix := udp.Prefix.Get()
	require.False(t, hasPrefix)
}

func TestNode_MergeExplicitKeysWin(t *testing.T) {
	n := mustParse(t, "$defs:\n  base: &base\n    a: 1\n    b: 2\nhost:\n  <<: *base\n  a: 10")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	var out map[string]int
	require.NoError(t, entries[1].value.Decode(&out))
	require.Equal(t, map[string]int{"a": 10, "b": 2}, out)
}

func TestNode_MergeSequenceEarlierWins(t *testing.T) {
	n := mustParse(t, "$defs:\n  one: &one\n    a: 1\n  two: &two\n    a: 2\n    b: 2\nhost:\n  <<: [*one, *two]")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	var out map[string]int
	require.NoError(t, entries[1].value.Decode(&out))
	require.Equal(t, map[string]int{"a": 1, "b": 2}, out)
}

func TestNode_MergeChainAndCycle(t *testing.T) {
	// Chained merges expand recursively.
	n := mustParse(t, "l1: &l1\n  a: 1\nl2: &l2\n  <<: *l1\n  b: 2\nhost:\n  <<: *l2")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	var out map[string]int
	require.NoError(t, entries[2].value.Decode(&out))
	require.Equal(t, map[string]int{"a": 1, "b": 2}, out)

	// A mapping that merges itself must error, not hang.
	n = mustParse(t, "host: &m\n  <<: *m\n  a: 1")
	entries, err = n.mappingEntries()
	require.NoError(t, err)
	_, err = entries[0].value.mappingEntries()
	require.Error(t, err)
	require.Contains(t, err.Error(), "merge")
}

func TestNode_MergeOfNonMapping(t *testing.T) {
	n := mustParse(t, "host:\n  <<: just-a-string")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	_, err = entries[0].value.mappingEntries()
	require.Error(t, err)
	require.Contains(t, err.Error(), "expected a map")
}

func TestNode_MergeAliasAmplificationBudget(t *testing.T) {
	var text strings.Builder
	text.WriteString("base: &base\n")
	for i := 0; i < 400; i++ {
		fmt.Fprintf(&text, "  key%d: %d\n", i, i)
	}
	text.WriteString("host:\n  <<: [")
	for i := 0; i < 300; i++ {
		if i > 0 {
			text.WriteString(", ")
		}
		text.WriteString("*base")
	}
	text.WriteString("]\n")

	root := mustParse(t, text.String())
	entries, err := root.mappingEntries()
	require.NoError(t, err)
	_, err = entries[1].value.mappingEntries()
	require.Error(t, err)
	require.Contains(t, err.Error(), "merge expansion exceeds 100000")
}

func TestError_Format(t *testing.T) {
	err := &Error{Path: "transport.endpoint", Line: 12, Err: errors.New("boom")}
	require.Equal(t, "transport.endpoint (line 12): boom", err.Error())
	require.ErrorContains(t, &Error{Err: errors.New("boom")}, "boom")
	require.ErrorIs(t, err, err.Err)
}
