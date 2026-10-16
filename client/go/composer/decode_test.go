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

func decodeAll[T any](t *testing.T, yamlText string) T {
	t.Helper()
	var out T
	require.NoError(t, mustParse(t, yamlText).Decode(&out))
	return out
}

func TestDecode_Scalars(t *testing.T) {
	require.Equal(t, "hello", decodeAll[string](t, "hello"))
	require.Equal(t, "line1\nline2\n", decodeAll[string](t, "|\n  line1\n  line2\n"))
	require.Equal(t, 443, decodeAll[int](t, "443"))
	require.Equal(t, -7, decodeAll[int](t, "-7"))
	require.Equal(t, uint16(8080), decodeAll[uint16](t, "8080"))
	require.Equal(t, 1.5, decodeAll[float64](t, "1.5"))
	require.Equal(t, 2.0, decodeAll[float64](t, "2"))
	require.Equal(t, true, decodeAll[bool](t, "true"))
}

func TestDecode_ScalarErrors(t *testing.T) {
	var s string
	require.Error(t, mustParse(t, "443").Decode(&s), "no int->string coercion")

	var i int
	require.Error(t, mustParse(t, `"443"`).Decode(&i), "no string->int coercion")

	var i8 int8
	require.Error(t, mustParse(t, "1000").Decode(&i8), "int8 range check")

	var u uint16
	require.Error(t, mustParse(t, "70000").Decode(&u), "uint16 range check")
	require.Error(t, mustParse(t, "-1").Decode(&u), "negative into uint")

	var b bool
	require.Error(t, mustParse(t, "yes").Decode(&b), "only true/false are bool")

	require.Error(t, mustParse(t, "1").Decode(i), "out must be a pointer")

	var missing int
	require.Error(t, mustParse(t, "").Decode(&missing), "absent into required scalar")
}

func TestDecode_NodeTarget(t *testing.T) {
	var n Node
	require.NoError(t, mustParse(t, "a: 1\nb: 2").Decode(&n))
	require.Equal(t, KindMapping, n.Kind())
}

func TestDecode_Optional(t *testing.T) {
	var set Optional[int]
	require.NoError(t, mustParse(t, "7").Decode(&set))
	v, ok := set.Get()
	require.True(t, ok)
	require.Equal(t, 7, v)

	var absent Optional[int]
	require.NoError(t, mustParse(t, "null").Decode(&absent))
	_, ok = absent.Get()
	require.False(t, ok, "explicit null leaves Optional absent")
}

type wsTestConfig struct {
	URL      string
	Endpoint Optional[Node]
	Retries  Optional[int]
}

func TestDecodeStruct_Basic(t *testing.T) {
	cfg := decodeAll[wsTestConfig](t, "url: wss://example.com\nendpoint: example.com:443")
	require.Equal(t, "wss://example.com", cfg.URL)
	ep, ok := cfg.Endpoint.Get()
	require.True(t, ok)
	require.Equal(t, KindScalar, ep.Kind())
	require.Equal(t, 3, cfg.Retries.Or(3))
}

func TestDecodeStruct_RequiredMissing(t *testing.T) {
	var cfg wsTestConfig
	err := mustParse(t, "endpoint: example.com:443").Decode(&cfg)
	require.Error(t, err)
	require.Contains(t, err.Error(), "url")

	// Explicit null does not satisfy a required field.
	err = mustParse(t, "url: null").Decode(&cfg)
	require.Error(t, err)
}

func TestDecodeStruct_NameMatching(t *testing.T) {
	type legacyConfig struct {
		ServerPort uint16
	}
	require.Equal(t, uint16(8388),
		decodeAll[legacyConfig](t, "server_port: 8388").ServerPort)
	require.Equal(t, uint16(8388),
		decodeAll[legacyConfig](t, "serverport: 8388").ServerPort)
}

func TestDecodeStruct_ReservedAndIgnorable(t *testing.T) {
	type cfg struct{ Cipher string }

	// $ keys are skipped.
	c := decodeAll[cfg](t, "$type: shadowsocks\ncipher: aes")
	require.Equal(t, "aes", c.Cipher)

	// Unknown field without ? is an ErrUnsupported error.
	var out cfg
	err := mustParse(t, "cipher: aes\npadding: 32").Decode(&out)
	require.ErrorIs(t, err, errors.ErrUnsupported)
	require.Contains(t, err.Error(), "padding")

	// Unknown field with ? is skipped.
	c = decodeAll[cfg](t, "cipher: aes\npadding?: 32")
	require.Equal(t, "aes", c.Cipher)

	// Known field with ? decodes normally.
	c = decodeAll[cfg](t, "cipher?: aes")
	require.Equal(t, "aes", c.Cipher)
}

func TestDecodeStruct_ConflictingKeys(t *testing.T) {
	type cfg struct{ Cipher Optional[string] }
	var out cfg
	err := mustParse(t, "cipher: aes\ncipher?: chacha").Decode(&out)
	require.Error(t, err)
}

func TestDecodeStruct_Nested(t *testing.T) {
	type request struct {
		URL    string
		Method Optional[string]
	}
	type reporter struct {
		Request  request
		Interval Optional[string]
	}
	r := decodeAll[reporter](t, "request:\n  url: https://example.com\ninterval: 2h")
	require.Equal(t, "https://example.com", r.Request.URL)
	require.Equal(t, "2h", r.Interval.Or(""))
}

func TestDecodeStruct_NotAMapping(t *testing.T) {
	var cfg wsTestConfig
	require.Error(t, mustParse(t, "just-a-string").Decode(&cfg))
}

func TestDecode_Slices(t *testing.T) {
	type entry struct {
		IPs    []string
		Dialer Optional[Node]
	}
	type table struct{ Table []entry }
	tbl := decodeAll[table](t, "table:\n  - ips: [\"1.1.1.1\", \"8.8.8.8/32\"]\n  - ips: [\"9.9.9.9\"]")
	require.Len(t, tbl.Table, 2)
	require.Equal(t, []string{"1.1.1.1", "8.8.8.8/32"}, tbl.Table[0].IPs)

	var s []int
	require.Error(t, mustParse(t, "not-a-list").Decode(&s))
}

func TestDecode_StringMap(t *testing.T) {
	type req struct{ Headers map[string][]string }
	r := decodeAll[req](t, "headers:\n  User-Agent: [outline]\n  $weird: [kept]")
	// Map keys are verbatim: no $ skipping, no ? semantics.
	require.Equal(t, []string{"outline"}, r.Headers["User-Agent"])
	require.Equal(t, []string{"kept"}, r.Headers["$weird"])

	var bad map[int]string
	require.Error(t, mustParse(t, "1: a").Decode(&bad), "non-string map keys unsupported")
}

func TestDecode_NamedStringMapKey(t *testing.T) {
	type headerName string
	var headers map[headerName]string
	require.NoError(t, mustParse(t, "Content-Type: application/json").Decode(&headers))
	require.Equal(t, map[headerName]string{"Content-Type": "application/json"}, headers)
}

// deepMap is a recursive map type that lets Decode follow a mapping
// chain of arbitrary depth.
type deepMap map[string]deepMap

func TestDecode_DepthLimit(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 150; i++ {
		sb.WriteString(strings.Repeat("  ", i) + "a:\n")
	}
	sb.WriteString(strings.Repeat("  ", 150) + "a: 1")
	var out deepMap
	err := mustParse(t, sb.String()).Decode(&out)
	require.Error(t, err)
	require.Contains(t, err.Error(), "nesting exceeds")
}

// amp18 is 18 nested slice layers. With each alias level referencing the
// previous one twice, decoding the payload below visits ~2^19 nodes if
// unchecked — the billion-laughs shape the visit budget must stop.
type amp18 = [][][][][][][][][][][][][][][][][][]string

func TestDecode_AliasAmplificationBudget(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("l0: &l0 [x, x]\n")
	for i := 1; i < 18; i++ {
		fmt.Fprintf(&sb, "l%d: &l%d [*l%d, *l%d]\n", i, i, i-1, i-1)
	}
	sb.WriteString("payload: *l17\n")
	n := mustParse(t, sb.String())
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	payload := entries[len(entries)-1].value

	var out amp18
	err = payload.Decode(&out)
	require.Error(t, err)
	require.Contains(t, err.Error(), "100000")
}

func TestDecode_ErrorHasPathAndLine(t *testing.T) {
	n := mustParse(t, "a: 1\nb: oops")
	entries, err := n.mappingEntries()
	require.NoError(t, err)
	var i int
	err = entries[1].value.Decode(&i)
	require.Error(t, err)
	require.Contains(t, err.Error(), "b")
	require.Contains(t, err.Error(), "line 2")
}
