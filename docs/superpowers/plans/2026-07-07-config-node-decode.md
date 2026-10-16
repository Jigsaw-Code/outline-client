# Config Node + Decode Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the new `composer` core package (Outline Composer) — an opaque `Node` handle over the YAML AST, a convention-based `Decode` with required-by-default fields and sender-side `?` optionality, and a `TypeParser` on top — validated by a spike, and fully documented (wire-format spec + design-decision log).

**Architecture:** A new package `client/go/composer` (Go import `localhost/client/go/composer`) coexists with the legacy `client/go/configyaml` until a follow-up migration plan ports the parsers in `configregistry`, `reporting`, and `client.go`. `Node` wraps `github.com/goccy/go-yaml` AST nodes (never exposed in signatures) and carries a config path plus a document-wide anchor table for lazy alias resolution. `Node.Decode` walks the AST with reflection: struct fields are matched by normalized name (no struct tags), fields are required unless typed `composer.Optional[T]`, `$`-prefixed keys are reserved, and a `?` key suffix marks sender-side ignorable fields. Unknown non-ignorable fields and unknown `$type` values produce errors wrapping `errors.ErrUnsupported`, which the built-in `first-supported` combinator uses to fall through.

**Tech Stack:** Go (repo module `localhost`), `github.com/goccy/go-yaml` v1.18.0 (`parser`, `ast`, `token` subpackages), `github.com/stretchr/testify/require` for tests.

## Global Constraints

- Go per repo root `go.mod`; run all commands from the repo root `/Users/fortuna/code/outline-apps`.
- New package directory: `client/go/composer`. Do NOT modify `client/go/configyaml` or `client/go/outline/**` in this plan.
- Tests use `github.com/stretchr/testify/require`, table-driven where natural, matching the style of `client/go/configyaml/parse_test.go`.
- Every Go file starts with the Apache 2.0 license header used across the repo (copy the 13-line header from `client/go/configyaml/parse.go`, year 2026).
- goccy AST types (`ast.Node` etc.) must never appear in any exported signature of package `composer`.
- Format code with `gofmt -w` before each commit; `go vet ./client/go/composer/...` must pass.
- Test command: `go test ./client/go/composer/... -v -run <TestName>`; full: `go test ./client/go/composer/...`.
- Commit messages follow repo style (`feat(client/go): ...`) and end with the trailer line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

- `client/go/composer/doc.go` — package comment.
- `client/go/composer/goccy_test.go` — spike: canary tests pinning the goccy AST behaviors we rely on (kept permanently; they alarm on library upgrades).
- `client/go/composer/SPEC.md` — the wire-format specification (normative).
- `client/go/composer/DESIGN.md` — design-decision log (why, alternatives rejected).
- `client/go/composer/naming.go` + `naming_test.go` — field-name convention and normalization.
- `client/go/composer/optional.go` + `optional_test.go` — `Optional[T]`.
- `client/go/composer/node.go` + `node_test.go` — `Error`, `Kind`, `Node`, `ParseYAML`, anchor/alias resolution, mapping/sequence access.
- `client/go/composer/decode.go` + `decode_test.go` — `Node.Decode` for scalars, structs, slices, maps; limits.
- `client/go/composer/typeparser.go` + `typeparser_test.go` — `ParseFunc`, `TypeParser`, `RegisterParser`, built-in `first-supported`.
- `client/go/composer/integration_test.go` — end-to-end scenario + error-message goldens.

---

### Task 1: Spike — goccy AST canary tests

Purpose: validate every assumption the design makes about goccy v1.18.0 **before** building on it. These tests are kept permanently as upgrade canaries.

**GO/NO-GO checkpoint:** if any test below fails, STOP, record the actual behavior in the test (make it pin reality), and flag the design impact to the plan owner before continuing. Known open questions this task answers:
1. Does a single-pair mapping parse as `*ast.MappingValueNode` instead of `*ast.MappingNode`?
2. Are line/column positions available on every node via `GetToken().Position`?
3. What Go types does `IntegerNode.Value` hold (int64 vs uint64)?
4. Does `padding?: 32` parse as a plain key string `padding?`?
5. Do anchors/aliases appear as `*ast.AnchorNode` / `*ast.AliasNode`, with NO automatic resolution on a detached subtree?
6. What does a merge key `<<: *a` parse to?
7. What does an explicit empty value (`key:`) parse to — `*ast.NullNode` or nil?
8. Do block literals (`|`) parse as `*ast.LiteralNode` with the string value accessible?

**Files:**
- Create: `client/go/composer/doc.go`
- Create: `client/go/composer/goccy_test.go`

**Interfaces:**
- Produces: package `composer` exists (empty). Findings feed Task 2's DESIGN.md and the implementations in Tasks 5–8.

- [ ] **Step 1: Create the package**

`client/go/composer/doc.go` (license header omitted here for brevity — include it):

```go
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
```

- [ ] **Step 2: Write the spike tests**

`client/go/composer/goccy_test.go`:

```go
package composer

import (
	"testing"

	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/parser"
	"github.com/stretchr/testify/require"
)

func parseBody(t *testing.T, text string) ast.Node {
	t.Helper()
	f, err := parser.ParseBytes([]byte(text), 0)
	require.NoError(t, err)
	require.NotEmpty(t, f.Docs)
	return f.Docs[0].Body
}

// Q1: single-pair mappings parse as *ast.MappingValueNode, multi-pair as *ast.MappingNode.
func TestGoccy_MappingShapes(t *testing.T) {
	single := parseBody(t, "key: value")
	require.IsType(t, &ast.MappingValueNode{}, single)

	multi := parseBody(t, "a: 1\nb: 2")
	require.IsType(t, &ast.MappingNode{}, multi)

	flow := parseBody(t, "{a: 1}")
	// Flow style may parse as MappingNode even with one pair; accept either shape.
	switch flow.(type) {
	case *ast.MappingNode, *ast.MappingValueNode:
	default:
		t.Fatalf("flow mapping parsed as %T", flow)
	}
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

	nested, ok := m.Values[1].Value.(*ast.MappingValueNode)
	require.True(t, ok)
	require.Equal(t, 3, nested.Key.GetToken().Position.Line)
}

// Q3: IntegerNode.Value is int64 for normal ints, uint64 for values beyond MaxInt64.
func TestGoccy_ScalarTypes(t *testing.T) {
	kv := parseBody(t, "n: 443").(*ast.MappingValueNode)
	iv, ok := kv.Value.(*ast.IntegerNode)
	require.True(t, ok)
	require.Equal(t, int64(443), iv.Value)

	kv = parseBody(t, "n: 18446744073709551615").(*ast.MappingValueNode)
	iv, ok = kv.Value.(*ast.IntegerNode)
	require.True(t, ok)
	require.Equal(t, uint64(18446744073709551615), iv.Value)

	kv = parseBody(t, "s: hello").(*ast.MappingValueNode)
	require.IsType(t, &ast.StringNode{}, kv.Value)

	kv = parseBody(t, `s: "443"`).(*ast.MappingValueNode)
	sv, ok := kv.Value.(*ast.StringNode)
	require.True(t, ok)
	require.Equal(t, "443", sv.Value)

	kv = parseBody(t, "b: true").(*ast.MappingValueNode)
	require.IsType(t, &ast.BoolNode{}, kv.Value)

	// YAML 1.2: yes/no are strings, not booleans. If this fails, the
	// SPEC's "only true/false are bool" rule needs library-level work.
	kv = parseBody(t, "b: yes").(*ast.MappingValueNode)
	require.IsType(t, &ast.StringNode{}, kv.Value)
}

// Q4: a trailing '?' is part of a plain YAML key.
func TestGoccy_QuestionMarkSuffixKey(t *testing.T) {
	kv := parseBody(t, "padding?: 32").(*ast.MappingValueNode)
	require.Equal(t, "padding?", kv.Key.GetToken().Value)
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
	kv := parseBody(t, "key:").(*ast.MappingValueNode)
	require.IsType(t, &ast.NullNode{}, kv.Value)

	kv = parseBody(t, "key: null").(*ast.MappingValueNode)
	require.IsType(t, &ast.NullNode{}, kv.Value)
}

// Q8: block literals expose their text.
func TestGoccy_BlockLiteral(t *testing.T) {
	kv := parseBody(t, "body: |\n  line1\n  line2").(*ast.MappingValueNode)
	lit, ok := kv.Value.(*ast.LiteralNode)
	require.True(t, ok)
	require.Equal(t, "line1\nline2\n", lit.Value.Value)
}
```

- [ ] **Step 3: Run the spike**

Run: `go test ./client/go/composer/... -v`
Expected: ideally all PASS. Any FAIL is spike output, not a defect: inspect the actual type/value with `t.Logf`, change the assertion to pin the real behavior, and note the design impact (e.g. if Q4 fails, the `?` suffix needs a different sigil — STOP and report to the plan owner).

- [ ] **Step 4: Commit**

```bash
git add client/go/composer/
git commit -m "test(client/go): add config spike pinning goccy AST behavior

Canary tests for the AST properties the new composer.Node design relies
on. They double as an alarm when upgrading github.com/goccy/go-yaml.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: SPEC.md and DESIGN.md

Record the wire format and the design decisions **now**, while they are fresh; later tasks implement what these documents say. Update both at the end (Task 10) with anything learned.

**Files:**
- Create: `client/go/composer/SPEC.md`
- Create: `client/go/composer/DESIGN.md`

**Interfaces:**
- Produces: normative rules referenced by Tasks 3–9 (naming convention, `?`/`$` semantics, scalar conversion table, limits).

- [ ] **Step 1: Write SPEC.md**

`client/go/composer/SPEC.md`:

```markdown
# Outline Config Format Specification

Status: Draft. This document is normative for the `composer` package.

## Documents

A config is a single-document YAML text (JSON, being a YAML subset, is
also valid). Multi-document streams are rejected.

## Values

A config value is one of:

- **Scalar**: string, integer, float, boolean.
- **Mapping**: string keys to config values.
- **Sequence**: list of config values.
- **Absent**: a missing field, or an explicit `null`/empty value.
  `field: null` and omitting `field` are equivalent.

YAML anchors (`&name`) and aliases (`*name`) are supported and resolved
by the framework, with limits (see Limits). YAML merge keys (`<<`) are
NOT supported and produce an error; use anchors on whole values instead.

## Reserved key namespace: `$`

Mapping keys starting with `$` are reserved for the framework and are
never treated as fields:

- `$type` (string): selects the registered sub-parser for the value.
  A mapping without `$type` is handled by the type's fallback rules
  (e.g. scalar shorthand, legacy formats).
- `$defs`: the conventional place to define YAML anchors for reuse
  elsewhere in the document; parsers ignore its content.
- All other `$` keys are reserved for future use and ignored.

## Field naming

Field names are lowercase `snake_case` (e.g. `server_port`). Matching is
tolerant: keys are compared case-insensitively with underscores removed,
so `serverport` and `Server_Port` match the same field. The canonical
spelling used in documentation and error messages is `snake_case`.

## Sender-side optional fields: the `?` suffix

A key ending in `?` (e.g. `padding?: 32`) tells the parser the field is
**safe to ignore if unknown**:

- Known field, `?` suffix: parsed normally; the `?` changes nothing.
- Unknown field, `?` suffix: skipped.
- Unknown field, no `?`: an error that matches `errors.ErrUnsupported`.
- The same field appearing both with and without `?`: an error.

The `?` marker applies to key *recognition* only. If the field is known,
errors inside its value are real errors. For a whole optional subtree
with fallback semantics, use `first-supported`.

## Receiver-side required fields

Parsers declare their schema as Go structs. Every exported struct field
is **required by default**: the config must set it to a non-absent value.
Fields typed `composer.Optional[T]` are optional. There are no struct tags.

Unknown fields (without `?`) are always errors: they mean the client
cannot faithfully implement the composer.

## Scalar conversions

| Config value      | Go targets                          | Notes                                |
|-------------------|-------------------------------------|--------------------------------------|
| string, block `|` | `string`                            | no coercion from numbers or booleans |
| integer           | `int*`, `uint*` (range-checked), `float*` | no coercion from strings       |
| float             | `float32`, `float64`                |                                      |
| boolean           | `bool`                              | only `true`/`false`                  |

A mapping decodes into a struct or a `map[string]T` (map keys are taken
verbatim: no `$`/`?` semantics). A sequence decodes into a slice. Any
value can decode into a `composer.Node` to defer parsing.

## Negotiation and `first-supported`

Errors that mean "this client cannot handle this config" — unknown
`$type`, unknown required field, unsupported platform — match
`errors.ErrUnsupported`. The built-in combinator:

```yaml
$type: first-supported
options:
  - {$type: fancy-new-thing, ...}
  - {$type: old-reliable, ...}
```

tries each option in order, skipping only options that fail with
`ErrUnsupported`; any other error aborts. If no option is supported the
combined error (matching `ErrUnsupported`) reports why each option failed.

## Limits

To protect against adversarial configs:

- Alias indirection: at most 20 levels.
- Decode depth: at most 100 nested levels.
- Decode work: at most 100,000 nodes visited per Decode call
  (defeats billion-laughs style alias amplification).
```

- [ ] **Step 2: Write DESIGN.md**

`client/go/composer/DESIGN.md`:

```markdown
# Config System Design Decisions

A log of the key decisions behind the `composer` package, so future
maintainers (and the Outline SDK migration) know what was decided and
why. Each entry: decision, rationale, alternatives rejected.

## D1. YAML as the wire format

JSON is a strict YAML subset, so JSON remains valid. YAML adds comments,
unquoted keys, and anchors. Parsing uses `github.com/goccy/go-yaml`
after correctness issues with `gopkg.in/yaml.v3` (outline-apps#2576).

## D2. Opaque `Node` handle instead of `any` trees or `[]byte`

Parsers exchange `composer.Node`, an immutable handle hiding the goccy AST.

- vs `any` trees (old `configyaml.ConfigNode`): keeps source positions
  for error messages, self-documenting delegated fields, swappable
  backend (a YAML-library change touches one package, not every parser).
- vs `[]byte`: rejected decisively because YAML anchors don't survive
  subtree extraction — `endpoint: *proxy` is meaningless as standalone
  bytes — plus it would force reparsing and lose positions.

goccy types never appear in exported signatures.

## D3. No struct tags; naming by convention

Struct tags would couple config structs to the decoding library; change
the decoder, rewrite every struct. Instead the wire name is derived from
the Go field name (CamelCase → snake_case, acronym runs as one word) and
matching is normalization-based (lowercase, strip underscores). The
struct alone is the schema.

## D4. Required by default; `Optional[T]` for optional fields

Optionality is part of the schema, so it lives in the type system:
`Optional[T]` with `Get()` and `Or(default)`. `*T` pointers were
considered (Go tradition) but rejected: less self-documenting, nil
footguns, and no defaulting idiom. Explicit `null` equals absent.
For the migration: legacy structs do not encode optionality, but each
legacy parser already validates its required fields explicitly (e.g.
shadowsocks rejects an empty cipher or secret). When porting, mirror
that: validated-required fields stay plain, the rest become
`Optional[T]`.

## D5. Sender-side criticality: the `?` key suffix

The config author marks ignorable fields with a trailing `?` on the key
(`padding?: 32`) — strict by default, opt-out per field, like X.509
critical extensions (inverted). Local to the field, valid JSON,
TypeScript-familiar. Rejected: a `$optional: [names]` list (declaration
at a distance, repetition). Sender-side `?` and receiver-side
`Optional[T]` are orthogonal axes owned by different parties.

## D6. `errors.ErrUnsupported` unifies negotiation

Unknown `$type`, unknown required field, and platform-unsupported
features all wrap `errors.ErrUnsupported`, so `first-supported` handles
graceful degradation for all of them. Providers get two tiers of
forward compatibility: `?` for ignorable tweaks, `first-supported` for
structural alternatives. Mitigation for typo'd field names being
swallowed: when no option is supported, first-supported reports every
option's error.

## D7. `first-supported` is built into `TypeParser`

Generic combinators must exist for every parsed type; leaving
registration to each call site caused duplicated wiring (and one
near-miss bug) in the legacy system. `NewTypeParser` registers built-in
combinators itself.

## D8. No re-dispatch loop in `TypeParser.Parse`

The legacy parse loop re-dispatched when a sub-parser returned another
config — a macro facility that the type system made unusable (sub-parsers
return T, not nodes). Dropped for a single dispatch step. If macros are
ever needed, they should be an explicit, depth-guarded transformer
concept.

## D9. Own reflection decoder, no third-party mapping library

The semantics are bespoke ($-reserved keys, ? suffix, ErrUnsupported
classification, path+position errors, Optional detection). Wrapping
mapstructure or goccy's decoder would need as much pre/post-processing
code as a direct ~300-line AST walker, with less control. The legacy
map→JSON→YAML round-trip (MapToAny) is retired.

## D10. Anchors resolved by the framework; merge keys rejected

ParseYAML builds a document-wide anchor table; nodes resolve aliases
lazily (no upfront expansion, so no memory amplification). Decode
enforces depth and node-count budgets against billion-laughs configs.
Merge keys (`<<`) are rejected explicitly: rarely needed, complicate
the unknown-field story, and anchors on whole values cover the use case.

## D11. Scalar shorthand stays in fallback handlers

`Decode` of a scalar into a struct errors. Type-level shorthand
("host:443" as a full endpoint) is per-type semantics and lives in each
TypeParser's fallback handler, as in the legacy design.

## D12. Coexistence and migration

The package is built alongside `configyaml` and adopted by porting one
parser chain at a time in a follow-up plan; `configyaml` is deleted at
the end. Long-term destination: the Outline SDK (this package has no
Outline-app dependencies by design — app policy like ConnectionProviderInfo,
DNS interception, and User-Agent stays in the app layer).

## D13. Package name: `composer`

The system is Outline Composer: the notation and toolkit that lets
anyone compose network strategies — the tool for composing, not the
entity doing the composing. "We built the notation; you write the
music." Rejected: `config` (too generic, and it collides with the
ubiquitous `config` local-variable name at call sites) and `configyaml`
(ties the name to one serialization format when the core is
format-agnostic).
```

- [ ] **Step 3: Commit**

```bash
git add client/go/composer/SPEC.md client/go/composer/DESIGN.md
git commit -m "docs(client/go): add config format spec and design decision log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Naming convention

**Files:**
- Create: `client/go/composer/naming.go`
- Test: `client/go/composer/naming_test.go`

**Interfaces:**
- Produces: `normalizeKey(key string) string`, `wireName(goName string) string` (both unexported; used by Tasks 7 and 9).

- [ ] **Step 1: Write the failing tests**

`client/go/composer/naming_test.go`:

```go
package composer

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeKey(t *testing.T) {
	for in, want := range map[string]string{
		"server_port": "serverport",
		"ServerPort":  "serverport",
		"URL":         "url",
		"Enable_Cookies": "enablecookies",
	} {
		require.Equal(t, want, normalizeKey(in), "normalizeKey(%q)", in)
	}
}

func TestWireName(t *testing.T) {
	for in, want := range map[string]string{
		"URL":             "url",
		"Endpoint":        "endpoint",
		"ServerPort":      "server_port",
		"EnableHTTPProxy": "enable_http_proxy",
		"IPs":             "ips",
	} {
		require.Equal(t, want, wireName(in), "wireName(%q)", in)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/composer/... -run 'TestNormalizeKey|TestWireName' -v`
Expected: FAIL (undefined: normalizeKey, wireName).

- [ ] **Step 3: Implement**

`client/go/composer/naming.go`:

```go
package composer

import (
	"strings"
	"unicode"
)

// normalizeKey returns the form used to match config keys against Go
// field names: lowercase with underscores removed. "server_port",
// "ServerPort" and "serverport" all normalize identically.
func normalizeKey(key string) string {
	return strings.ToLower(strings.ReplaceAll(key, "_", ""))
}

// wireName converts a Go field name to its canonical snake_case wire
// name. Acronym runs count as one word: URL -> url,
// EnableHTTPProxy -> enable_http_proxy.
func wireName(goName string) string {
	var b strings.Builder
	runes := []rune(goName)
	for i, r := range runes {
		if unicode.IsUpper(r) && i > 0 &&
			(!unicode.IsUpper(runes[i-1]) ||
				(i+1 < len(runes) && unicode.IsLower(runes[i+1]))) {
			b.WriteByte('_')
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/composer/... -run 'TestNormalizeKey|TestWireName' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/naming.go client/go/composer/naming_test.go
git commit -m "feat(client/go): add config field naming convention

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Optional[T]

**Files:**
- Create: `client/go/composer/optional.go`
- Test: `client/go/composer/optional_test.go`

**Interfaces:**
- Produces: `Optional[T]` with `NewOptional[T](v T) Optional[T]`, `(Optional[T]) Get() (T, bool)`, `(Optional[T]) Or(fallback T) T`; unexported decoder hook `optionalField` interface with `valuePtr() any` and `markPresent()` implemented by `*Optional[T]`. Task 7's decoder detects optional fields via this interface.

- [ ] **Step 1: Write the failing tests**

`client/go/composer/optional_test.go`:

```go
package composer

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOptional_Absent(t *testing.T) {
	var o Optional[int]
	v, ok := o.Get()
	require.False(t, ok)
	require.Zero(t, v)
	require.Equal(t, 42, o.Or(42))
}

func TestOptional_Present(t *testing.T) {
	o := NewOptional("hello")
	v, ok := o.Get()
	require.True(t, ok)
	require.Equal(t, "hello", v)
	require.Equal(t, "hello", o.Or("fallback"))
}

func TestOptional_DecoderHook(t *testing.T) {
	var o Optional[int]
	var hook optionalField = &o
	*(hook.valuePtr().(*int)) = 7
	hook.markPresent()
	v, ok := o.Get()
	require.True(t, ok)
	require.Equal(t, 7, v)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/composer/... -run TestOptional -v`
Expected: FAIL (undefined: Optional).

- [ ] **Step 3: Implement**

`client/go/composer/optional.go`:

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/composer/... -run TestOptional -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/optional.go client/go/composer/optional_test.go
git commit -m "feat(client/go): add composer.Optional for optional fields

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Node, Error, ParseYAML, anchor resolution

**Files:**
- Create: `client/go/composer/node.go`
- Test: `client/go/composer/node_test.go`

**Interfaces:**
- Consumes: spike findings (Task 1) for AST shapes.
- Produces (exported): `type Kind int` with `KindAbsent/KindScalar/KindMapping/KindSequence` and `(Kind) String() string`; `type Node struct{...}` (zero value = absent) with `Kind() Kind`, `IsAbsent() bool`, `Path() string`; `ParseYAML(text []byte) (Node, error)`; `type Error struct{ Path string; Line, Column int; Err error }` with `Error() string` and `Unwrap() error`; `const TypeKey = "$type"`.
- Produces (unexported, for Tasks 6–9): `(Node) mappingEntries() ([]mapEntry, error)` where `mapEntry{key string, value Node}`; `(Node) sequenceItems() ([]Node, error)`; `(Node) typeName() (name string, found bool, err error)`; `(Node) errorf(format string, args ...any) error`; `(Node) wrapErr(err error) error`.

- [ ] **Step 1: Write the failing tests**

`client/go/composer/node_test.go`:

```go
package composer

import (
	"errors"
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

	// Single-pair mapping (may be a different AST shape).
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

func TestNode_AliasUnknownAndCyclic(t *testing.T) {
	n := mustParse(t, "a: *nowhere")
	_, err := n.mappingEntries()
	require.Error(t, err)
	require.Contains(t, err.Error(), "nowhere")

	// Self-referential alias must hit the depth limit, not hang.
	n = mustParse(t, "a: &x *x")
	_, err = n.mappingEntries()
	require.Error(t, err)
}

func TestError_Format(t *testing.T) {
	err := &Error{Path: "transport.endpoint", Line: 12, Err: errors.New("boom")}
	require.Equal(t, "transport.endpoint (line 12): boom", err.Error())
	require.ErrorContains(t, &Error{Err: errors.New("boom")}, "boom")
	require.ErrorIs(t, err, err.Err)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/composer/... -run 'TestParseYAML|TestNode_|TestError_' -v`
Expected: FAIL (undefined: ParseYAML, Node, ...).

- [ ] **Step 3: Implement**

`client/go/composer/node.go`:

```go
package composer

import (
	"errors"
	"fmt"

	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/parser"
)

// TypeKey is the reserved mapping key that selects a registered sub-parser.
const TypeKey = "$type"

const maxAliasDepth = 20

// Kind describes the shape of a config Node.
type Kind int

const (
	KindAbsent Kind = iota
	KindScalar
	KindMapping
	KindSequence
)

func (k Kind) String() string {
	switch k {
	case KindAbsent:
		return "absent"
	case KindScalar:
		return "scalar"
	case KindMapping:
		return "map"
	case KindSequence:
		return "list"
	default:
		return fmt.Sprintf("Kind(%d)", int(k))
	}
}

// Error is a config processing error annotated with the config path and
// source position. It unwraps to the underlying error, so sentinel
// checks like errors.Is(err, errors.ErrUnsupported) work through it.
type Error struct {
	Path         string
	Line, Column int
	Err          error
}

func (e *Error) Error() string {
	loc := e.Path
	if loc == "" {
		loc = "config"
	}
	if e.Line > 0 {
		loc = fmt.Sprintf("%s (line %d)", loc, e.Line)
	}
	return fmt.Sprintf("%s: %v", loc, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// Node is an immutable handle into a parsed configuration. The zero
// value is an absent node. Node hides the underlying YAML representation
// so it can be replaced without changing parsers.
type Node struct {
	ast     ast.Node
	anchors map[string]ast.Node
	path    string
}

// ParseYAML parses a single-document YAML (or JSON) text into a Node.
// An empty document yields an absent Node.
func ParseYAML(text []byte) (Node, error) {
	file, err := parser.ParseBytes(text, 0)
	if err != nil {
		return Node{}, fmt.Errorf("invalid YAML: %w", err)
	}
	if len(file.Docs) > 1 {
		return Node{}, errors.New("multi-document YAML is not supported")
	}
	if len(file.Docs) == 0 || file.Docs[0].Body == nil {
		return Node{}, nil
	}
	anchors := make(map[string]ast.Node)
	collectAnchors(file.Docs[0].Body, anchors)
	return (Node{ast: file.Docs[0].Body, anchors: anchors}).deref()
}

// collectAnchors indexes every anchor definition in the document, so
// aliases resolve regardless of where the referencing subtree ends up.
func collectAnchors(n ast.Node, anchors map[string]ast.Node) {
	switch t := n.(type) {
	case *ast.AnchorNode:
		anchors[t.Name.GetToken().Value] = t.Value
		collectAnchors(t.Value, anchors)
	case *ast.MappingNode:
		for _, kv := range t.Values {
			collectAnchors(kv.Value, anchors)
		}
	case *ast.MappingValueNode:
		collectAnchors(t.Value, anchors)
	case *ast.SequenceNode:
		for _, v := range t.Values {
			collectAnchors(v, anchors)
		}
	}
}

// Kind returns the shape of the node. Explicit null counts as absent.
func (n Node) Kind() Kind {
	switch n.ast.(type) {
	case nil, *ast.NullNode:
		return KindAbsent
	case *ast.MappingNode, *ast.MappingValueNode:
		return KindMapping
	case *ast.SequenceNode:
		return KindSequence
	default:
		return KindScalar
	}
}

// IsAbsent reports whether the node is missing or explicitly null.
func (n Node) IsAbsent() bool { return n.Kind() == KindAbsent }

// Path returns the location of this node in the config, e.g.
// "transport.endpoint.options[1]". The root path is "".
func (n Node) Path() string { return n.path }

// deref unwraps anchor definitions and resolves alias references so
// that n.ast is always a mapping, sequence, scalar, or null.
func (n Node) deref() (Node, error) {
	for depth := 0; ; {
		switch t := n.ast.(type) {
		case *ast.AnchorNode:
			n.ast = t.Value
		case *ast.AliasNode:
			depth++
			if depth > maxAliasDepth {
				return Node{}, n.errorf("alias nesting exceeds %d levels", maxAliasDepth)
			}
			name := t.Value.GetToken().Value
			target, ok := n.anchors[name]
			if !ok {
				return Node{}, n.errorf("unknown anchor %q", name)
			}
			n.ast = target
		default:
			return n, nil
		}
	}
}

func (n Node) childNode(a ast.Node, path string) (Node, error) {
	return (Node{ast: a, anchors: n.anchors, path: path}).deref()
}

func joinPath(base, key string) string {
	if base == "" {
		return key
	}
	return base + "." + key
}

type mapEntry struct {
	key   string
	value Node
}

// mappingEntries returns the key/value pairs of a mapping node in
// document order.
func (n Node) mappingEntries() ([]mapEntry, error) {
	var kvs []*ast.MappingValueNode
	switch t := n.ast.(type) {
	case *ast.MappingNode:
		kvs = t.Values
	case *ast.MappingValueNode:
		kvs = []*ast.MappingValueNode{t}
	default:
		return nil, n.errorf("expected a map, found %v", n.Kind())
	}
	entries := make([]mapEntry, 0, len(kvs))
	for _, kv := range kvs {
		key := kv.Key.GetToken().Value
		child, err := n.childNode(kv.Value, joinPath(n.path, key))
		if err != nil {
			return nil, err
		}
		entries = append(entries, mapEntry{key: key, value: child})
	}
	return entries, nil
}

// sequenceItems returns the elements of a sequence node.
func (n Node) sequenceItems() ([]Node, error) {
	seq, ok := n.ast.(*ast.SequenceNode)
	if !ok {
		return nil, n.errorf("expected a list, found %v", n.Kind())
	}
	items := make([]Node, 0, len(seq.Values))
	for i, v := range seq.Values {
		child, err := n.childNode(v, fmt.Sprintf("%s[%d]", n.path, i))
		if err != nil {
			return nil, err
		}
		items = append(items, child)
	}
	return items, nil
}

// typeName returns the value of the $type key of a mapping node.
func (n Node) typeName() (string, bool, error) {
	if n.Kind() != KindMapping {
		return "", false, nil
	}
	entries, err := n.mappingEntries()
	if err != nil {
		return "", false, err
	}
	for _, e := range entries {
		if e.key != TypeKey {
			continue
		}
		var name string
		if err := e.value.Decode(&name); err != nil {
			return "", false, fmt.Errorf("%s must be a string: %w", TypeKey, err)
		}
		return name, true, nil
	}
	return "", false, nil
}

func (n Node) errorf(format string, args ...any) error {
	return n.wrapErr(fmt.Errorf(format, args...))
}

func (n Node) wrapErr(err error) error {
	e := &Error{Path: n.path, Err: err}
	if n.ast != nil {
		if tok := n.ast.GetToken(); tok != nil && tok.Position != nil {
			e.Line, e.Column = tok.Position.Line, tok.Position.Column
		}
	}
	return e
}
```

Note: `typeName` calls `(Node).Decode`, which Task 6 implements. To keep this task compiling and testable on its own, add a temporary minimal `Decode` in `node.go` supporting only `*string` — Task 6 replaces it:

```go
// Decode is implemented in decode.go; temporary string-only version.
func (n Node) Decode(out any) error {
	s, ok := out.(*string)
	if !ok {
		return n.errorf("decode not implemented yet for %T", out)
	}
	sn, ok := n.ast.(*ast.StringNode)
	if !ok {
		return n.errorf("expected a string, found %v", n.Kind())
	}
	*s = sn.Value
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/composer/... -v`
Expected: PASS (all node tests plus prior tasks' tests).

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/node.go client/go/composer/node_test.go
git commit -m "feat(client/go): add composer.Node with paths, positions, and alias resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Decode — scalars, Node targets, Optional targets

**Files:**
- Create: `client/go/composer/decode.go` (move the temporary `Decode` out of `node.go` and replace it)
- Modify: `client/go/composer/node.go` (delete the temporary `Decode`)
- Test: `client/go/composer/decode_test.go`

**Interfaces:**
- Consumes: `Node` internals (Task 5), `optionalField` (Task 4).
- Produces: `(n Node) Decode(out any) error` handling: `*string` (StringNode + LiteralNode), `*int*`/`*uint*` (range-checked), `*float32/64` (FloatNode or IntegerNode), `*bool`, `*Node` (raw handover), `*Optional[T]` (absent → stays absent), plus struct/slice/map dispatch stubs that Tasks 7–8 fill (`decodeStruct`, `decodeSlice`, `decodeMap` — declare them in this task returning `n.errorf("not implemented")` so the file compiles). Internal: `type decodeState struct{ visited int }`, `(n Node) decodeValue(dst reflect.Value, depth int, st *decodeState) error`, constants `maxDecodeDepth = 100`, `maxDecodeNodes = 100000`.

- [ ] **Step 1: Write the failing tests**

`client/go/composer/decode_test.go`:

```go
package composer

import (
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
	require.Equal(t, "line1\nline2\n", decodeAll[string](t, "|\n  line1\n  line2"))
	require.Equal(t, 443, decodeAll[int](t, "443"))
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/composer/... -run TestDecode -v`
Expected: FAIL (temporary Decode only handles `*string`; several tests fail).

- [ ] **Step 3: Implement**

Delete the temporary `Decode` from `node.go`. Create `client/go/composer/decode.go`:

```go
package composer

import (
	"fmt"
	"math"
	"reflect"

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

func (n Node) decodeScalar(dst reflect.Value) error {
	switch dst.Kind() {
	case reflect.String:
		switch t := n.ast.(type) {
		case *ast.StringNode:
			dst.SetString(t.Value)
		case *ast.LiteralNode:
			dst.SetString(t.Value.Value)
		default:
			return n.errorf("expected a string, found %v", n.Kind())
		}
	case reflect.Bool:
		t, ok := n.ast.(*ast.BoolNode)
		if !ok {
			return n.errorf("expected a boolean, found %v", n.Kind())
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
			return n.errorf("expected a number, found %v", n.Kind())
		}
	}
	return nil
}

func (n Node) intValue() (int64, error) {
	iv, ok := n.ast.(*ast.IntegerNode)
	if !ok {
		return 0, n.errorf("expected an integer, found %v", n.Kind())
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
		return 0, n.errorf("expected an integer, found %v", n.Kind())
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

// Implemented in Task 7.
func (n Node) decodeStruct(dst reflect.Value, depth int, st *decodeState) error {
	return n.errorf("struct decoding not implemented")
}

// Implemented in Task 8.
func (n Node) decodeSlice(dst reflect.Value, depth int, st *decodeState) error {
	return n.errorf("slice decoding not implemented")
}

// Implemented in Task 8.
func (n Node) decodeMap(dst reflect.Value, depth int, st *decodeState) error {
	return n.errorf("map decoding not implemented")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/composer/... -v`
Expected: PASS (including Task 5's tests, whose `typeName` now uses the real Decode).

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/decode.go client/go/composer/decode_test.go client/go/composer/node.go
git commit -m "feat(client/go): add composer.Node.Decode for scalars, Node, and Optional targets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Decode — structs (required/Optional/`?`/`$`/unknown fields)

**Files:**
- Modify: `client/go/composer/decode.go` (replace the `decodeStruct` stub)
- Test: `client/go/composer/decode_test.go` (append)

**Interfaces:**
- Consumes: `normalizeKey`/`wireName` (Task 3), `optionalField` (Task 4), `mappingEntries` (Task 5).
- Produces: struct decoding per SPEC.md — exported fields matched by normalized name; required by default; `Optional[T]` optional; `$`-prefixed keys skipped; `key?` ignorable-if-unknown; unknown plain key → `*Error` wrapping `errors.ErrUnsupported`; duplicate/conflicting keys → error; nested structs recurse.

- [ ] **Step 1: Write the failing tests**

Append to `client/go/composer/decode_test.go`:

```go
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
```

Also add `"errors"` to the test file imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/composer/... -run TestDecodeStruct -v`
Expected: FAIL with "struct decoding not implemented".

- [ ] **Step 3: Implement**

Replace the `decodeStruct` stub in `client/go/composer/decode.go` with:

```go
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
	for norm, field := range fields {
		if _, ok := seen[norm]; ok {
			continue
		}
		fv := dst.Field(field.index)
		if _, isOpt := fv.Addr().Interface().(optionalField); isOpt {
			continue
		}
		return n.errorf("required field %q is missing", wireName(field.goName))
	}
	return nil
}
```

Add `"errors"` and `"strings"` to the imports of `decode.go`.

One subtlety the tests cover: a required field explicitly set to `null` (`url: null`). The entry IS in `seen`, so the missing-field check passes, but `decodeValue` on the null node hits the `n.IsAbsent()` branch and returns "required value is missing" — correct behavior, no extra code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/composer/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/decode.go client/go/composer/decode_test.go
git commit -m "feat(client/go): decode structs with required-by-default and ?-ignorable fields

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Decode — slices, string-keyed maps, adversarial limits

**Files:**
- Modify: `client/go/composer/decode.go` (replace `decodeSlice`/`decodeMap` stubs)
- Test: `client/go/composer/decode_test.go` (append)

**Interfaces:**
- Consumes: `sequenceItems`/`mappingEntries` (Task 5).
- Produces: sequence → slice; mapping → `map[string]T` (keys verbatim, no `$`/`?` handling); depth and node-budget enforcement proven by tests.

- [ ] **Step 1: Write the failing tests**

Append to `client/go/composer/decode_test.go`:

```go
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
// unchecked — the billion-laughs shape the node budget must stop.
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
```

Add `"fmt"` and `"strings"` to the test file's imports. Note the two limit tests distinguish their failure messages: depth trips "config nesting exceeds 100 levels", the alias amplification (depth only 18) trips the visit budget "config exceeds 100000 values".

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/composer/... -run 'TestDecode_Slices|TestDecode_StringMap|TestDecode_NodeBudget|TestDecode_DepthLimit' -v`
Expected: FAIL with "slice decoding not implemented" / "map decoding not implemented".

- [ ] **Step 3: Implement**

Replace the stubs in `client/go/composer/decode.go`:

```go
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
		val := reflect.New(dst.Type().Elem()).Elem()
		if err := entry.value.decodeValue(val, depth+1, st); err != nil {
			return err
		}
		out.SetMapIndex(reflect.ValueOf(entry.key), val)
	}
	dst.Set(out)
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/composer/... -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/decode.go client/go/composer/decode_test.go
git commit -m "feat(client/go): decode slices and maps; enforce adversarial-config budgets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: TypeParser, RegisterParser, built-in first-supported

**Files:**
- Create: `client/go/composer/typeparser.go`
- Test: `client/go/composer/typeparser_test.go`

**Interfaces:**
- Consumes: `Node.typeName` (Task 5), `Node.Decode` (Tasks 6–8).
- Produces (exported): `type ParseFunc[T any] func(ctx context.Context, node Node) (T, error)`; `NewTypeParser[T any](fallback ParseFunc[T]) *TypeParser[T]`; `(p *TypeParser[T]) RegisterSubParser(name string, f ParseFunc[T])` (panics on duplicate name); `(p *TypeParser[T]) Parse(ctx context.Context, node Node) (T, error)`; `RegisterParser[Cfg, T any](p *TypeParser[T], name string, build func(ctx context.Context, cfg Cfg) (T, error))`. `first-supported` is auto-registered by `NewTypeParser`. No re-dispatch loop: one `$type` lookup, one call.

- [ ] **Step 1: Write the failing tests**

`client/go/composer/typeparser_test.go`:

```go
package composer

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeDialer struct {
	kind string
	addr string
}

func newTestParser(t *testing.T) *TypeParser[*fakeDialer] {
	t.Helper()
	p := NewTypeParser(func(ctx context.Context, node Node) (*fakeDialer, error) {
		if node.IsAbsent() {
			return &fakeDialer{kind: "direct"}, nil
		}
		var addr string
		if err := node.Decode(&addr); err == nil {
			return &fakeDialer{kind: "shorthand", addr: addr}, nil
		}
		return nil, errors.New("parser not specified")
	})
	type ssConfig struct {
		Endpoint string
		Cipher   Optional[string]
	}
	RegisterParser(p, "ss", func(ctx context.Context, cfg ssConfig) (*fakeDialer, error) {
		return &fakeDialer{kind: "ss", addr: cfg.Endpoint}, nil
	})
	p.RegisterSubParser("broken", func(ctx context.Context, node Node) (*fakeDialer, error) {
		return nil, errors.New("bad params")
	})
	return p
}

func TestTypeParser_Dispatch(t *testing.T) {
	p := newTestParser(t)
	d, err := p.Parse(context.Background(), mustParse(t, "$type: ss\nendpoint: example.com:443"))
	require.NoError(t, err)
	require.Equal(t, &fakeDialer{kind: "ss", addr: "example.com:443"}, d)
}

func TestTypeParser_Fallbacks(t *testing.T) {
	p := newTestParser(t)

	d, err := p.Parse(context.Background(), mustParse(t, `"example.com:443"`))
	require.NoError(t, err)
	require.Equal(t, "shorthand", d.kind)

	d, err = p.Parse(context.Background(), Node{})
	require.NoError(t, err)
	require.Equal(t, "direct", d.kind)

	// Mapping without $type goes to the fallback too.
	_, err = p.Parse(context.Background(), mustParse(t, "endpoint: example.com"))
	require.Error(t, err)
}

func TestTypeParser_UnknownType(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, "$type: warp-drive"))
	require.ErrorIs(t, err, errors.ErrUnsupported)
	require.Contains(t, err.Error(), "warp-drive")
}

func TestTypeParser_DuplicateRegistrationPanics(t *testing.T) {
	p := newTestParser(t)
	require.Panics(t, func() {
		p.RegisterSubParser("ss", func(ctx context.Context, node Node) (*fakeDialer, error) {
			return nil, nil
		})
	})
}

func TestFirstSupported_PicksFirstSupported(t *testing.T) {
	p := newTestParser(t)
	d, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: warp-drive
    speed: 9
  - $type: ss
    endpoint: example.com:443
`))
	require.NoError(t, err)
	require.Equal(t, "ss", d.kind)
}

func TestFirstSupported_HardErrorAborts(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: broken
  - $type: ss
    endpoint: example.com:443
`))
	require.Error(t, err)
	require.NotErrorIs(t, err, errors.ErrUnsupported)
}

func TestFirstSupported_NoneSupported(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: warp-drive
  - $type: teleport
`))
	require.ErrorIs(t, err, errors.ErrUnsupported)
	// The combined error reports why each option failed.
	require.Contains(t, err.Error(), "warp-drive")
	require.Contains(t, err.Error(), "teleport")
}

func TestFirstSupported_Empty(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, "$type: first-supported\noptions: []"))
	require.Error(t, err)
}

func TestFirstSupported_UnknownRequiredFieldFallsThrough(t *testing.T) {
	// An unknown required field inside an option is ErrUnsupported,
	// so first-supported moves on; with ? it would have been accepted.
	p := newTestParser(t)
	d, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: ss
    endpoint: example.com:443
    quantum_padding: 7
  - $type: ss
    endpoint: fallback.example.com:443
`))
	require.NoError(t, err)
	require.Equal(t, "fallback.example.com:443", d.addr)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/composer/... -run 'TestTypeParser|TestFirstSupported' -v`
Expected: FAIL (undefined: TypeParser, ...).

- [ ] **Step 3: Implement**

`client/go/composer/typeparser.go`:

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/composer/... -v`
Expected: PASS. Note `TestFirstSupported_NoneSupported` relies on `errors.Join`: `errors.Is` matches if any joined error matches, and all joined errors are `ErrUnsupported`, so the combined error still satisfies the sentinel.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/typeparser.go client/go/composer/typeparser_test.go
git commit -m "feat(client/go): add TypeParser with typed registration and built-in first-supported

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end integration test and error-message goldens

This is the "does it work in practice" half of the spike: a realistic composed config exercising `$type` dispatch, delegated `Node` fields, scalar shorthand, anchors, `?` fields, `first-supported`, and the exact error strings a provider would see.

**Files:**
- Create: `client/go/composer/integration_test.go`

**Interfaces:**
- Consumes: everything from Tasks 3–9. No new production code; if a test here cannot be written cleanly, that is a design finding — record it in DESIGN.md (Task 11) and fix the core.

- [ ] **Step 1: Write the integration test**

`client/go/composer/integration_test.go`:

```go
package composer_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"localhost/client/go/composer"
	"github.com/stretchr/testify/require"
)

// A miniature transport model mirroring configregistry's shape:
// endpoints wrap dialers, transports wrap endpoints.
type endpoint struct {
	desc string
}

type transport struct {
	endpoint *endpoint
	cipher   string
	padding  int
}

func newEndpointParser() *composer.TypeParser[*endpoint] {
	var endpoints *composer.TypeParser[*endpoint]
	endpoints = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (*endpoint, error) {
		var addr string
		if err := node.Decode(&addr); err != nil {
			return nil, fmt.Errorf("endpoint must be an address string: %w", err)
		}
		return &endpoint{desc: "dial " + addr}, nil
	})
	type wsConfig struct {
		URL      string
		Endpoint composer.Optional[composer.Node]
	}
	composer.RegisterParser(endpoints, "websocket", func(ctx context.Context, cfg wsConfig) (*endpoint, error) {
		inner := "derived"
		if epNode, ok := cfg.Endpoint.Get(); ok {
			ep, err := endpoints.Parse(ctx, epNode)
			if err != nil {
				return nil, err
			}
			inner = ep.desc
		}
		return &endpoint{desc: fmt.Sprintf("ws %s over (%s)", cfg.URL, inner)}, nil
	})
	return endpoints
}

func newTransportParser(endpoints *composer.TypeParser[*endpoint]) *composer.TypeParser[*transport] {
	transports := composer.NewTypeParser(func(ctx context.Context, node composer.Node) (*transport, error) {
		return nil, errors.New("parser not specified")
	})
	type ssConfig struct {
		Endpoint composer.Node
		Cipher   string
		Padding  composer.Optional[int]
	}
	composer.RegisterParser(transports, "ss", func(ctx context.Context, cfg ssConfig) (*transport, error) {
		ep, err := endpoints.Parse(ctx, cfg.Endpoint)
		if err != nil {
			return nil, err
		}
		return &transport{endpoint: ep, cipher: cfg.Cipher, padding: cfg.Padding.Or(0)}, nil
	})
	return transports
}

const fullConfig = `
$defs:
  proxy_addr: &proxy "proxy.example.com:443"
$type: first-supported
options:
  - $type: quantum-tunnel
    endpoint: *proxy
  - $type: ss
    cipher: chacha20-ietf-poly1305
    padding?: 16
    experimental_knob?: true
    endpoint:
      $type: websocket
      url: wss://cdn.example.com/tcp
      endpoint: *proxy
`

func TestIntegration_FullConfig(t *testing.T) {
	root, err := composer.ParseYAML([]byte(fullConfig))
	require.NoError(t, err)

	transports := newTransportParser(newEndpointParser())
	tr, err := transports.Parse(context.Background(), root)
	require.NoError(t, err)
	require.Equal(t, "chacha20-ietf-poly1305", tr.cipher)
	require.Equal(t, 16, tr.padding, "known ?-field is used")
	require.Equal(t, "ws wss://cdn.example.com/tcp over (dial proxy.example.com:443)",
		tr.endpoint.desc, "anchor + delegated node resolve through the chain")
}

func TestIntegration_ErrorGoldens(t *testing.T) {
	transports := newTransportParser(newEndpointParser())
	parse := func(text string) error {
		root, err := composer.ParseYAML([]byte(text))
		require.NoError(t, err)
		_, err = transports.Parse(context.Background(), root)
		return err
	}

	tests := []struct {
		name, yaml string
		want       []string // substrings the provider-facing error must contain
	}{
		{
			name: "unknown type",
			yaml: "$type: warp-drive",
			want: []string{"warp-drive", "not supported"},
		},
		{
			name: "unknown required field with position",
			yaml: "$type: ss\ncipher: aes\nendpoint: e:443\ntypo_field: 1",
			want: []string{"typo_field", "line 4"},
		},
		{
			name: "missing required field",
			yaml: "$type: ss\ncipher: aes",
			want: []string{"endpoint", "missing"},
		},
		{
			name: "nested error carries path",
			yaml: "$type: ss\ncipher: aes\nendpoint:\n  $type: websocket\n  url: 123",
			want: []string{"url", "line 5"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := parse(tc.yaml)
			require.Error(t, err)
			for _, want := range tc.want {
				require.Contains(t, err.Error(), want)
			}
			t.Logf("golden: %v", err)
		})
	}
}
```

- [ ] **Step 2: Run and inspect the goldens**

Run: `go test ./client/go/composer/... -run TestIntegration -v`
Expected: PASS, with `t.Logf` output showing each error string. **Read the logged errors**: they are what a config author sees. If any is confusing (e.g. missing path context), improve the message in the core and re-run — that polish is in scope for this task.

- [ ] **Step 3: Run the full suite and vet**

Run: `go test ./client/go/composer/... && go vet ./client/go/composer/...`
Expected: all PASS, vet clean.

- [ ] **Step 4: Commit**

```bash
gofmt -w client/go/composer && git add client/go/composer/integration_test.go
git commit -m "test(client/go): add config end-to-end integration and error goldens

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation finalization and migration pointer

**Files:**
- Modify: `client/go/composer/DESIGN.md` (spike findings, any decision adjusted during Tasks 3–10)
- Modify: `client/go/composer/SPEC.md` (anything that changed)
- Create: `client/go/composer/AGENTS.md`
- Modify: `client/go/outline/configregistry/AGENTS.md` (add a pointer)

**Interfaces:**
- Consumes: the implemented behavior; deviations discovered during implementation.

- [ ] **Step 1: Reconcile docs with implementation**

Re-read `SPEC.md` and `DESIGN.md` against the final code. Update anything that drifted (limits, error formats, merge-key behavior as pinned by the spike). Append a `## Spike findings` section to DESIGN.md summarizing what Task 1 confirmed or corrected (mapping shapes, integer types, `?`-key parsing, alias AST behavior).

- [ ] **Step 2: Write the package agent guide**

`client/go/composer/AGENTS.md`:

```markdown
# The `composer` Package (Outline Composer)

Core of Outline's extensible configuration system. Read SPEC.md for the
wire format (normative) and DESIGN.md for why things are the way they are.

## Adding a new config type

1. Define a plain Go struct. No tags. Fields are required unless typed
   `composer.Optional[T]`. Use `composer.Node` for delegated sub-configs.
2. Write a build function `func(ctx context.Context, cfg MyConfig) (T, error)`.
   If it delegates, take the needed `composer.ParseFunc` as a constructor
   argument so the dependency is explicit and compile-checked.
3. Register it: `composer.RegisterParser(parser, "my-type", build)`.

Keep application policy (metadata, DNS behavior, User-Agent) out of this
package; it is destined for the Outline SDK and must stay app-agnostic.

## Status

Built alongside the legacy `client/go/configyaml`; the migration of
`configregistry`, `reporting`, and `client.go` onto this package is a
separate follow-up plan (see docs/superpowers/plans/). Do not add new
parsers to `configyaml`.
```

- [ ] **Step 3: Point the legacy registry at the new package**

Append to `client/go/outline/configregistry/AGENTS.md`:

```markdown
## Migration note (2026-07)

A new config core lives in `client/go/composer` (see its SPEC.md and
DESIGN.md): opaque `composer.Node`, tag-free struct decoding with
required-by-default fields, `?`-suffix ignorable fields, and a
`TypeParser` with built-in `first-supported`. New strategies should be
designed against that API; this package will migrate to it in a
follow-up plan.
```

- [ ] **Step 4: Final full check and commit**

Run: `go test ./client/go/composer/... && go vet ./client/go/composer/...`
Expected: PASS, clean.

```bash
git add client/go/composer/ client/go/outline/configregistry/AGENTS.md
git commit -m "docs(client/go): finalize config package docs and migration pointers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope (follow-up plan)

Deliberately excluded here; write a second plan once this one lands:

1. Porting `configregistry` parsers (shadowsocks incl. URL formats, websocket, iptable, block, dial endpoint, tcpudp, proxyless), `reporting`, and `client.go` to `composer` — carrying each parser's existing required-field validation into the types (fields it validates as required stay plain; the rest become `Optional[T]`).
2. Separating app policy from parsers (ConnectionProviderInfo propagation, Outline DNS wrap, User-Agent injection) via injection/annotation.
3. Deleting `client/go/configyaml`.
4. The Outline SDK move and `x/configurl` reconciliation.
