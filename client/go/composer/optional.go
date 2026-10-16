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

// Optional marks a config struct field that the config may omit.
// Fields not wrapped in Optional are required: Decode fails if the
// config does not set them. The zero value is absent.
type Optional[T any] struct {
	value   T
	present bool
}

// NewOptional returns an Optional holding value.
func NewOptional[T any](value T) Optional[T] {
	return Optional[T]{value: value, present: true}
}

// Get returns the value and whether it was set.
func (o Optional[T]) Get() (T, bool) {
	return o.value, o.present
}

// Or returns the value if set, otherwise fallback.
func (o Optional[T]) Or(fallback T) T {
	if o.present {
		return o.value
	}
	return fallback
}

// optionalField is how the decoder fills an Optional without knowing T.
type optionalField interface {
	// valuePtr returns a *T to decode into.
	valuePtr() any
	markPresent()
}

func (o *Optional[T]) valuePtr() any { return &o.value }
func (o *Optional[T]) markPresent()  { o.present = true }
