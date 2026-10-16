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
	"context"
	"errors"
	"fmt"
)

// ParseFunc parses a config node into a value of type T.
type ParseFunc[T any] func(ctx context.Context, node Node) (T, error)

// TypeParser parses configs for type T, dispatching mappings with a
// $type key to registered sub-parsers. Create it with NewTypeParser.
// Registration is not safe for concurrent use; register at setup time.
type TypeParser[T any] struct {
	fallback   ParseFunc[T]
	subparsers map[string]ParseFunc[T]
}

// NewTypeParser creates a TypeParser. The fallback handles configs
// without a $type: absent nodes, scalar shorthand, and legacy mapping
// formats. Built-in combinators (first-supported) are pre-registered.
func NewTypeParser[T any](fallback ParseFunc[T]) *TypeParser[T] {
	p := &TypeParser[T]{
		fallback:   fallback,
		subparsers: make(map[string]ParseFunc[T]),
	}
	registerFirstSupported(p)
	return p
}

// RegisterSubParser registers f for configs with `$type: name`.
// It panics if name is already registered: silent replacement would
// let one extension hijack another.
func (p *TypeParser[T]) RegisterSubParser(name string, f ParseFunc[T]) {
	if _, exists := p.subparsers[name]; exists {
		panic(fmt.Sprintf("composer: sub-parser %q registered twice", name))
	}
	p.subparsers[name] = f
}

// Parse implements ParseFunc[T].
func (p *TypeParser[T]) Parse(ctx context.Context, node Node) (T, error) {
	var zero T
	name, found, err := node.typeName()
	if err != nil {
		return zero, err
	}
	if !found {
		return p.fallback(ctx, node)
	}
	sub, ok := p.subparsers[name]
	if !ok {
		return zero, node.errorf("config type %q is not supported: %w", name, errors.ErrUnsupported)
	}
	out, err := sub(ctx, node)
	if err != nil {
		return zero, fmt.Errorf("%q config: %w", name, err)
	}
	return out, nil
}

// RegisterParser registers a typed sub-parser: the node is decoded into
// a Cfg (getting required/Optional/?-field semantics for free), then
// build turns the config into the runtime object. This is the
// recommended way to add a new config type.
func RegisterParser[Cfg any, T any](p *TypeParser[T], name string, build func(ctx context.Context, cfg Cfg) (T, error)) {
	p.RegisterSubParser(name, func(ctx context.Context, node Node) (T, error) {
		var zero T
		var cfg Cfg
		if err := node.Decode(&cfg); err != nil {
			return zero, err
		}
		return build(ctx, cfg)
	})
}

type firstSupportedConfig struct {
	Options []Node
}

// registerFirstSupported installs the first-supported combinator: it
// returns the first option that parses, skipping options that fail
// with errors.ErrUnsupported. Any other failure aborts immediately.
func registerFirstSupported[T any](p *TypeParser[T]) {
	RegisterParser(p, "first-supported", func(ctx context.Context, cfg firstSupportedConfig) (T, error) {
		var zero T
		if len(cfg.Options) == 0 {
			return zero, errors.New("empty list of options")
		}
		var optionErrs []error
		for _, option := range cfg.Options {
			out, err := p.Parse(ctx, option)
			if err == nil {
				return out, nil
			}
			if !errors.Is(err, errors.ErrUnsupported) {
				return zero, err
			}
			optionErrs = append(optionErrs, err)
		}
		return zero, fmt.Errorf("no supported option: %w", errors.Join(optionErrs...))
	})
}
