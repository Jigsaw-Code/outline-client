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

package registry

import (
	"context"
	"errors"
	"fmt"

	"localhost/client/go/composer"
)

// TypeName is the value of a config's $type field.
type TypeName string

// Kind identifies an extension point whose parsers produce values of type T.
// Kinds have opaque identity: separately declared kinds remain independent even
// if they have the same diagnostic name. A contract owner should declare one
// Kind value and share it with every implementation package.
type Kind[T any] struct {
	identity *kindIdentity
}

type kindIdentity struct {
	name string
}

// NewKind declares a typed extension point with a human-readable name used in
// errors and diagnostics.
func NewKind[T any](name string) Kind[T] {
	return Kind[T]{identity: &kindIdentity{name: name}}
}

// String returns the Kind's diagnostic name. The zero Kind has an empty name.
func (k Kind[T]) String() string {
	if k.identity == nil {
		return ""
	}
	return k.identity.name
}

// ParseRequest is the opaque, type-erased request passed through Composer.
// Wrappers may inspect its KindName and Node and then delegate it. Results stay
// private so ordinary callers cannot bypass the typed Parser function.
type ParseRequest struct {
	kind   *kindIdentity
	node   composer.Node
	assign func(any) error
}

// KindName returns the requested Kind's diagnostic name.
func (r ParseRequest) KindName() string {
	if r.kind == nil {
		return ""
	}
	return r.kind.name
}

// Node returns the config node being composed.
func (r ParseRequest) Node() composer.Node { return r.node }

// Composer is the capability to compose typed config values. Compose is the
// minimal type-erased seam used by Parser. Most code should use Parser instead;
// Compose exists so external wrappers can observe and delegate composition.
type Composer interface {
	Compose(ctx context.Context, request ParseRequest) error
}

// Registration is the opaque, type-erased request passed through Registrar.
// Values are constructed by the strongly typed Register and RegisterFallback
// functions.
type Registration struct {
	kind       *kindIdentity
	typeName   TypeName
	parse      composer.ParseFunc[any]
	isFallback bool
}

// KindName returns the registered Kind's diagnostic name.
func (r Registration) KindName() string {
	if r.kind == nil {
		return ""
	}
	return r.kind.name
}

// TypeName returns the registered $type name. It is empty for a fallback.
func (r Registration) TypeName() TypeName { return r.typeName }

// IsFallback reports whether this registration handles values without $type.
func (r Registration) IsFallback() bool { return r.isFallback }

// Registrar can register strategies and provide their parser dependencies.
// Registration and parsing are not safe for concurrent use.
type Registrar interface {
	Composer
	Register(registration Registration) error
}

type registry struct {
	categories map[*kindIdentity]*category
}

type category struct {
	parser      *composer.TypeParser[any]
	fallback    composer.ParseFunc[any]
	hasFallback bool
	typeNames   map[TypeName]struct{}
}

// New creates one registry value implementing both Registrar and Composer.
func New() Registrar {
	return &registry{categories: make(map[*kindIdentity]*category)}
}

type parseResult[T any] struct {
	value T
}

// Parser returns a late-bound parser for kind. It looks up the kind's current
// registrations whenever the returned function is invoked, so it may be
// acquired before implementations are registered and may be used recursively.
func Parser[T any](c Composer, kind Kind[T]) composer.ParseFunc[T] {
	return func(ctx context.Context, node composer.Node) (T, error) {
		var zero T
		if c == nil {
			return zero, errors.New("composer registry: nil Composer")
		}
		if kind.identity == nil {
			return zero, errors.New("composer registry: cannot parse with a zero Kind")
		}

		var result T
		assigned := false
		request := ParseRequest{
			kind: kind.identity,
			node: node,
			assign: func(value any) error {
				boxed, ok := value.(parseResult[T])
				if !ok {
					return fmt.Errorf("composer registry: invalid result for kind %q", kind.String())
				}
				result = boxed.value
				assigned = true
				return nil
			},
		}
		if err := c.Compose(ctx, request); err != nil {
			return zero, err
		}
		if !assigned {
			return zero, fmt.Errorf("composer registry: no result returned for kind %q", kind.String())
		}
		return result, nil
	}
}

// Register associates name with a typed parser under kind. Registering the
// same kind and name twice returns an error. An empty name is invalid; use
// RegisterFallback for values without $type.
func Register[T any](r Registrar, kind Kind[T], name TypeName, parse composer.ParseFunc[T]) error {
	if r == nil {
		return errors.New("composer registry: nil Registrar")
	}
	if kind.identity == nil {
		return errors.New("composer registry: cannot register with a zero Kind")
	}
	if name == "" {
		return errors.New("composer registry: empty TypeName; use RegisterFallback for values without $type")
	}
	if parse == nil {
		return fmt.Errorf("composer registry: nil parser for kind %q type %q", kind.String(), name)
	}
	return r.Register(Registration{
		kind:     kind.identity,
		typeName: name,
		parse:    eraseParseFunc(parse),
	})
}

// RegisterFallback registers the typed parser used for values without $type.
// Registering more than one fallback for a kind returns an error.
func RegisterFallback[T any](r Registrar, kind Kind[T], parse composer.ParseFunc[T]) error {
	if r == nil {
		return errors.New("composer registry: nil Registrar")
	}
	if kind.identity == nil {
		return errors.New("composer registry: cannot register a fallback with a zero Kind")
	}
	if parse == nil {
		return fmt.Errorf("composer registry: nil fallback parser for kind %q", kind.String())
	}
	return r.Register(Registration{
		kind:       kind.identity,
		parse:      eraseParseFunc(parse),
		isFallback: true,
	})
}

func eraseParseFunc[T any](parse composer.ParseFunc[T]) composer.ParseFunc[any] {
	return func(ctx context.Context, node composer.Node) (any, error) {
		value, err := parse(ctx, node)
		if err != nil {
			return nil, err
		}
		return parseResult[T]{value: value}, nil
	}
}

func (r *registry) Register(registration Registration) error {
	if registration.kind == nil || registration.parse == nil {
		return errors.New("composer registry: invalid registration")
	}
	if !registration.isFallback && registration.typeName == "" {
		return errors.New("composer registry: invalid registration with empty TypeName")
	}

	category := r.category(registration.kind)
	if registration.isFallback {
		if category.hasFallback {
			return fmt.Errorf("composer registry: fallback for kind %q is already registered", registration.kind.name)
		}
		category.fallback = registration.parse
		category.hasFallback = true
		return nil
	}
	if _, exists := category.typeNames[registration.typeName]; exists {
		return fmt.Errorf("composer registry: kind %q type %q is already registered", registration.kind.name, registration.typeName)
	}
	category.parser.RegisterSubParser(string(registration.typeName), registration.parse)
	category.typeNames[registration.typeName] = struct{}{}
	return nil
}

func (r *registry) Compose(ctx context.Context, request ParseRequest) error {
	if request.kind == nil || request.assign == nil {
		return errors.New("composer registry: invalid parse request")
	}
	category := r.categories[request.kind]
	if category == nil {
		// Keep registry lookup read-only during parsing. An unregistered Kind
		// gets a temporary empty category rather than mutating shared state.
		category = newCategory()
	}
	value, err := category.parser.Parse(ctx, request.node)
	if err != nil {
		return fmt.Errorf("composer registry: kind %q: %w", request.kind.name, err)
	}
	return request.assign(value)
}

func (r *registry) category(kind *kindIdentity) *category {
	entry := r.categories[kind]
	if entry != nil {
		return entry
	}
	entry = newCategory()
	r.categories[kind] = entry
	return entry
}

func newCategory() *category {
	entry := &category{
		typeNames: map[TypeName]struct{}{
			"first-supported": {},
		},
	}
	entry.parser = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (any, error) {
		if !entry.hasFallback {
			return nil, fmt.Errorf("config without %s has no registered fallback", composer.TypeKey)
		}
		return entry.fallback(ctx, node)
	})
	return entry
}
