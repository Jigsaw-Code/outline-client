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
	"testing"

	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/parser"
	"github.com/stretchr/testify/require"
)

// These tests pin the goccy/go-yaml AST behaviors the composer package
// relies on. They double as canaries: if a library upgrade changes any
// of these, the corresponding composer code must be revisited.

func parseBody(t *testing.T, text string) ast.Node {
	t.Helper()
	f, err := parser.ParseBytes([]byte(text), 0)
	require.NoError(t, err)
	require.NotEmpty(t, f.Docs)
	return f.Docs[0].Body
}

// firstValue returns the value of the first key of a mapping document.
func firstValue(t *testing.T, text string) ast.Node {
	t.Helper()
	m, ok := parseBody(t, text).(*ast.MappingNode)
	require.True(t, ok, "document is not a mapping")
	require.NotEmpty(t, m.Values)
	return m.Values[0].Value
}

// Q1: mappings always parse as *ast.MappingNode, regardless of size,
// style, or nesting (goccy v1.18; older versions used MappingValueNode
// for single-pair mappings).
func TestGoccy_MappingShapes(t *testing.T) {
	require.IsType(t, &ast.MappingNode{}, parseBody(t, "key: value"))
	require.IsType(t, &ast.MappingNode{}, parseBody(t, "a: 1\nb: 2"))
	require.IsType(t, &ast.MappingNode{}, parseBody(t, "{a: 1}"))
	require.IsType(t, &ast.MappingNode{}, firstValue(t, "b:\n  c: hello"))
}

// Q2: every node exposes a token with line/column position.
func TestGoccy_Positions(t *testing.T) {
	body := parseBody(t, "a: 1\nb:\n  c: hello")
	m, ok := body.(*ast.MappingNode)
	require.True(t, ok)
	require.Len(t, m.Values, 2)
	pos := m.Values[1].Key.GetToken().Position
	require.NotNil(t, pos)
	require.Equal(t, 2, pos.Line)

	nested, ok := m.Values[1].Value.(*ast.MappingNode)
	require.True(t, ok)
	require.Equal(t, 3, nested.Values[0].Key.GetToken().Position.Line)
}

// Q3: IntegerNode.Value is uint64 for non-negative integers (even small
// ones) and int64 for negative ones. Decoders must handle both.
func TestGoccy_ScalarTypes(t *testing.T) {
	iv, ok := firstValue(t, "n: 443").(*ast.IntegerNode)
	require.True(t, ok)
	require.Equal(t, uint64(443), iv.Value)

	iv, ok = firstValue(t, "n: -443").(*ast.IntegerNode)
	require.True(t, ok)
	require.Equal(t, int64(-443), iv.Value)

	iv, ok = firstValue(t, "n: 18446744073709551615").(*ast.IntegerNode)
	require.True(t, ok)
	require.Equal(t, uint64(18446744073709551615), iv.Value)

	require.IsType(t, &ast.StringNode{}, firstValue(t, "s: hello"))

	sv, ok := firstValue(t, `s: "443"`).(*ast.StringNode)
	require.True(t, ok)
	require.Equal(t, "443", sv.Value)

	require.IsType(t, &ast.BoolNode{}, firstValue(t, "b: true"))

	// YAML 1.2: yes/no are strings, not booleans. If this fails, the
	// SPEC's "only true/false are bool" rule needs library-level work.
	require.IsType(t, &ast.StringNode{}, firstValue(t, "b: yes"))
}

// Q4: a trailing '?' is part of a plain YAML key.
func TestGoccy_QuestionMarkSuffixKey(t *testing.T) {
	m := parseBody(t, "padding?: 32").(*ast.MappingNode)
	require.Equal(t, "padding?", m.Values[0].Key.GetToken().Value)
}

// Q5: anchors and aliases surface as AST nodes; nothing resolves them for us.
func TestGoccy_AnchorAliasShapes(t *testing.T) {
	body := parseBody(t, "a: &x\n  h: 1\nb: *x")
	m := body.(*ast.MappingNode)
	require.IsType(t, &ast.AnchorNode{}, m.Values[0].Value)
	anchor := m.Values[0].Value.(*ast.AnchorNode)
	require.Equal(t, "x", anchor.Name.GetToken().Value)

	require.IsType(t, &ast.AliasNode{}, m.Values[1].Value)
	alias := m.Values[1].Value.(*ast.AliasNode)
	require.Equal(t, "x", alias.Value.GetToken().Value)
}

// Q6: merge keys parse with a "<<" key token.
func TestGoccy_MergeKeyShape(t *testing.T) {
	body := parseBody(t, "base: &b\n  x: 1\nother:\n  <<: *b\n  y: 2")
	m := body.(*ast.MappingNode)
	inner := m.Values[1].Value.(*ast.MappingNode)
	require.Equal(t, "<<", inner.Values[0].Key.GetToken().Value)
}

// Q7: an explicit empty value parses as *ast.NullNode (not Go nil).
func TestGoccy_EmptyValue(t *testing.T) {
	require.IsType(t, &ast.NullNode{}, firstValue(t, "key:"))
	require.IsType(t, &ast.NullNode{}, firstValue(t, "key: null"))
}

// Q8: block literals expose their text, with YAML chomping already
// applied to the AST value (clip keeps the final newline when the
// source has one).
func TestGoccy_BlockLiteral(t *testing.T) {
	lit, ok := firstValue(t, "body: |\n  line1\n  line2\n").(*ast.LiteralNode)
	require.True(t, ok)
	require.Equal(t, "line1\nline2\n", lit.Value.Value)

	lit, ok = firstValue(t, "body: |-\n  line1\n  line2\n").(*ast.LiteralNode)
	require.True(t, ok)
	require.Equal(t, "line1\nline2", lit.Value.Value)
}
