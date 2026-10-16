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
	"math"
	"reflect"
	"strings"

	"github.com/goccy/go-yaml/ast"
)

const (
	maxDecodeDepth = 100
	maxDecodeNodes = 100_000
)

var nodeType = reflect.TypeOf(Node{})

// Decode maps the node onto out, which must be a non-nil pointer.
// See SPEC.md for conversion and field-matching rules.
func (n Node) Decode(out any) error {
	rv := reflect.ValueOf(out)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return fmt.Errorf("composer.Decode: out must be a non-nil pointer, got %T", out)
	}
	return n.decodeValue(rv.Elem(), 0, &decodeState{})
}

// decodeState carries the per-Decode work budget that bounds alias
// amplification (billion-laughs style configs).
type decodeState struct {
	visited int
}

func (n Node) decodeValue(dst reflect.Value, depth int, st *decodeState) error {
	if depth > maxDecodeDepth {
		return n.errorf("config nesting exceeds %d levels", maxDecodeDepth)
	}
	st.visited++
	if st.visited > maxDecodeNodes {
		return n.errorf("config exceeds %d values", maxDecodeNodes)
	}

	// Raw handover: the parser wants the subtree unparsed.
	if dst.Type() == nodeType {
		dst.Set(reflect.ValueOf(n))
		return nil
	}
	// Optional[T]: absent leaves it absent; otherwise decode into T.
	if dst.CanAddr() {
		if opt, ok := dst.Addr().Interface().(optionalField); ok {
			if n.IsAbsent() {
				return nil
			}
			opt.markPresent()
			return n.decodeValue(reflect.ValueOf(opt.valuePtr()).Elem(), depth+1, st)
		}
	}
	if n.IsAbsent() {
		return n.errorf("required value is missing")
	}

	switch dst.Kind() {
	case reflect.String, reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return n.decodeScalar(dst)
	case reflect.Struct:
		return n.decodeStruct(dst, depth, st)
	case reflect.Slice:
		return n.decodeSlice(dst, depth, st)
	case reflect.Map:
		return n.decodeMap(dst, depth, st)
	default:
		return n.errorf("unsupported target type %v", dst.Type())
	}
}

// describe names the node's concrete value type for error messages,
// e.g. "an integer" rather than the coarser Kind "scalar".
func (n Node) describe() string {
	switch n.ast.(type) {
	case nil, *ast.NullNode:
		return "absent"
	case *ast.StringNode, *ast.LiteralNode:
		return "a string"
	case *ast.IntegerNode:
		return "an integer"
	case *ast.FloatNode:
		return "a number"
	case *ast.BoolNode:
		return "a boolean"
	case *ast.MappingNode, *ast.MappingValueNode:
		return "a map"
	case *ast.SequenceNode:
		return "a list"
	default:
		return fmt.Sprintf("%T", n.ast)
	}
}

func (n Node) decodeScalar(dst reflect.Value) error {
	switch dst.Kind() {
	case reflect.String:
		switch t := n.ast.(type) {
		case *ast.StringNode:
			dst.SetString(t.Value)
		case *ast.LiteralNode:
			dst.SetString(t.Value.Value)
		default:
			return n.errorf("expected a string, found %s", n.describe())
		}
	case reflect.Bool:
		t, ok := n.ast.(*ast.BoolNode)
		if !ok {
			return n.errorf("expected a boolean, found %s", n.describe())
		}
		dst.SetBool(t.Value)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		i, err := n.intValue()
		if err != nil {
			return err
		}
		if dst.OverflowInt(i) {
			return n.errorf("value %d out of range for %v", i, dst.Type())
		}
		dst.SetInt(i)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		u, err := n.uintValue()
		if err != nil {
			return err
		}
		if dst.OverflowUint(u) {
			return n.errorf("value %d out of range for %v", u, dst.Type())
		}
		dst.SetUint(u)
	case reflect.Float32, reflect.Float64:
		switch t := n.ast.(type) {
		case *ast.FloatNode:
			dst.SetFloat(t.Value)
		case *ast.IntegerNode:
			i, err := n.intValue()
			if err != nil {
				return err
			}
			dst.SetFloat(float64(i))
		default:
			return n.errorf("expected a number, found %s", n.describe())
		}
	}
	return nil
}

// intValue extracts an integer scalar. goccy stores non-negative
// integers as uint64 and negative ones as int64 (see goccy_test.go).
func (n Node) intValue() (int64, error) {
	iv, ok := n.ast.(*ast.IntegerNode)
	if !ok {
		return 0, n.errorf("expected an integer, found %s", n.describe())
	}
	switch v := iv.Value.(type) {
	case int64:
		return v, nil
	case uint64:
		if v > math.MaxInt64 {
			return 0, n.errorf("value %d out of range", v)
		}
		return int64(v), nil
	default:
		return 0, n.errorf("unexpected integer representation %T", iv.Value)
	}
}

func (n Node) uintValue() (uint64, error) {
	iv, ok := n.ast.(*ast.IntegerNode)
	if !ok {
		return 0, n.errorf("expected an integer, found %s", n.describe())
	}
	switch v := iv.Value.(type) {
	case int64:
		if v < 0 {
			return 0, n.errorf("value %d must not be negative", v)
		}
		return uint64(v), nil
	case uint64:
		return v, nil
	default:
		return 0, n.errorf("unexpected integer representation %T", iv.Value)
	}
}

const (
	reservedPrefix  = "$"
	ignorableSuffix = "?"
)

type structField struct {
	index  int
	goName string
}

// structFields indexes the exported fields of t by normalized name.
func structFields(t reflect.Type) (map[string]structField, error) {
	fields := make(map[string]structField)
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		norm := normalizeKey(f.Name)
		if prev, ok := fields[norm]; ok {
			return nil, fmt.Errorf("struct %v: fields %s and %s have colliding config names", t, prev.goName, f.Name)
		}
		fields[norm] = structField{index: i, goName: f.Name}
	}
	return fields, nil
}

func (n Node) decodeStruct(dst reflect.Value, depth int, st *decodeState) error {
	entries, err := n.mappingEntries()
	if err != nil {
		return err
	}
	fields, err := structFields(dst.Type())
	if err != nil {
		return n.wrapErr(err)
	}

	seen := make(map[string]string) // normalized name -> config key as written
	for _, entry := range entries {
		key := entry.key
		if strings.HasPrefix(key, reservedPrefix) {
			// Reserved framework namespace ($type etc.); never a field.
			continue
		}
		name := strings.TrimSuffix(key, ignorableSuffix)
		ignorable := len(name) < len(key)
		norm := normalizeKey(name)
		if prev, dup := seen[norm]; dup {
			return entry.value.errorf("field %q conflicts with earlier %q", key, prev)
		}
		seen[norm] = key
		field, known := fields[norm]
		if !known {
			if ignorable {
				continue
			}
			return entry.value.errorf("unknown field %q: %w", name, errors.ErrUnsupported)
		}
		if err := entry.value.decodeValue(dst.Field(field.index), depth+1, st); err != nil {
			return err
		}
	}

	// Fields not set by the config: allowed only for Optional ones.
	// The normalized name is itself a valid wire spelling of the field
	// (matching is normalization-based), so it is safe to suggest.
	for norm, field := range fields {
		if _, ok := seen[norm]; ok {
			continue
		}
		fv := dst.Field(field.index)
		if _, isOpt := fv.Addr().Interface().(optionalField); isOpt {
			continue
		}
		return n.errorf("required field %q is missing", norm)
	}
	return nil
}

func (n Node) decodeSlice(dst reflect.Value, depth int, st *decodeState) error {
	items, err := n.sequenceItems()
	if err != nil {
		return err
	}
	out := reflect.MakeSlice(dst.Type(), len(items), len(items))
	for i, item := range items {
		if err := item.decodeValue(out.Index(i), depth+1, st); err != nil {
			return err
		}
	}
	dst.Set(out)
	return nil
}

// decodeMap fills a map[string]T. Unlike structs, map targets are open:
// keys are taken verbatim, with no $-reserved or ?-ignorable handling.
func (n Node) decodeMap(dst reflect.Value, depth int, st *decodeState) error {
	if dst.Type().Key().Kind() != reflect.String {
		return n.errorf("unsupported map key type %v", dst.Type().Key())
	}
	entries, err := n.mappingEntries()
	if err != nil {
		return err
	}
	out := reflect.MakeMapWithSize(dst.Type(), len(entries))
	for _, entry := range entries {
		key := reflect.New(dst.Type().Key()).Elem()
		key.SetString(entry.key)
		val := reflect.New(dst.Type().Elem()).Elem()
		if err := entry.value.decodeValue(val, depth+1, st); err != nil {
			return err
		}
		out.SetMapIndex(key, val)
	}
	dst.Set(out)
	return nil
}
