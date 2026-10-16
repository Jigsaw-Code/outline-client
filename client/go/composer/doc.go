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

// Package composer implements Outline Composer, the extensible
// configuration system for network strategies. Composer is the notation
// and the toolkit; users and service providers write the music.
//
// A configuration is a YAML (or JSON) document describing how to build
// objects such as dialers and endpoints. The package provides:
//   - Node: an opaque, immutable handle into the parsed config tree.
//   - (Node).Decode: maps a node onto a plain Go struct by naming
//     convention, with fields required by default and Optional[T] for
//     optional ones.
//   - TypeParser: dispatches a config to a registered sub-parser based
//     on its $type field.
//
// The wire format is specified in SPEC.md; design rationale is recorded
// in DESIGN.md.
package composer
