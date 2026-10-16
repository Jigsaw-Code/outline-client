# Composer Design Decisions

A log of the key decisions behind the `composer` package, so future
maintainers (and the Outline SDK migration) know what was decided and
why. Each entry: decision, rationale, alternatives rejected.

## D1. YAML as the wire format

JSON is a strict YAML subset, so JSON remains valid. YAML adds comments,
unquoted keys, and anchors. Parsing uses `github.com/goccy/go-yaml`
after correctness issues with `gopkg.in/yaml.v3` (outline-apps#2576).

## D2. Opaque `Node` handle instead of `any` trees or `[]byte`

Parsers exchange `composer.Node`, an immutable handle hiding the goccy
AST.

- vs `any` trees (old `configyaml.ConfigNode`): keeps source positions
  for error messages, self-documenting delegated fields, swappable
  backend (a YAML-library change touches one package, not every parser).
- vs `[]byte`: rejected decisively because YAML anchors don't survive
  subtree extraction — `endpoint: *proxy` is meaningless as standalone
  bytes — plus it would force reparsing and lose positions.

goccy types never appear in exported signatures.

## D3. No struct tags; naming by convention

Struct tags would couple config structs to the decoding library; change
the decoder, rewrite every struct. Instead matching is
normalization-based (lowercase, strip underscores), so any spelling that
normalizes to the Go field name works on the wire; `snake_case` is the
documented convention, not something the code derives. The struct alone
is the schema. An earlier revision derived a canonical snake_case
spelling from Go names (CamelCase → snake_case) for error messages, but
acronym/plural handling made it heuristic ("IPs"); it was dropped in
favor of naming fields by their normalized form, which is always itself
a valid spelling precisely because matching normalizes.

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

## D10. Anchors and merge keys resolved by the framework

ParseYAML builds a document-wide anchor table; nodes resolve aliases
lazily (no upfront expansion, so no memory amplification). Decode
enforces depth and node-count budgets against billion-laughs configs.

YAML merge keys (`<<`) are supported with standard YAML semantics:
explicit keys in the host mapping win over merged keys, and earlier
merge sources win over later ones. Merges are expanded when a mapping's
entries are read, before any field matching, so they work uniformly for
struct targets, map targets, and `$type` dispatch. Expansion is
depth-limited (20 levels) and work-limited (100,000 visited values), so
self-referential merges error instead of hanging and repeated aliases
cannot amplify a compact merge sequence into quadratic work. An earlier
draft rejected merge keys, but the official
access-key config documentation relies on them to de-duplicate config
sections (e.g. sharing cipher/secret between the tcp and udp
transports):
https://developer.getoutline.org/vpn/reference/access-key-config/

## D11. Scalar shorthand stays in fallback handlers

`Decode` of a scalar into a struct errors. Type-level shorthand
("host:443" as a full endpoint) is per-type semantics and lives in each
TypeParser's fallback handler, as in the legacy design.

## D12. Coexistence and migration

The package was built alongside `configyaml` and adopted by porting one
parser chain at a time in a follow-up plan; `configyaml` was deleted at
the end. Migration complete 2026-07-09: `client/go/composer/netconfig`
is now the transport-config layer (config interfaces, concrete config
types, and protocol parser constructors), and
`client/go/outline/configregistry` is the app layer that chooses wire
names and fallbacks, wraps those parsers to collect connection metadata,
and applies Outline policy (address resolution, DNS interception, User-Agent)
at the boundary. Long-term destination: the Outline SDK (this package has no
Outline-app dependencies by design — app policy like
`ConnectionProviderInfo`, DNS interception, and
User-Agent stays in the app layer, never in `composer` or `netconfig`).

## D13. Package name: `composer`

The system is Outline Composer: the notation and toolkit that lets
anyone compose network strategies — the tool for composing, not the
entity doing the composing. "We built the notation; you write the
music." Rejected: `config` (too generic, and it collides with the
ubiquitous `config` local-variable name at call sites) and `configyaml`
(ties the name to one serialization format when the core is
format-agnostic).

## D14. Package layout: one `composer/` root for everything SDK-bound

The Composer system lives under a single package tree — `composer`
(format core), `composer/registry` (typed extension points), and
`composer/netconfig` (strategy config vocabulary) — following the
stdlib `go/` family pattern (`go/ast`, `go/parser`, `go/types`:
siblings under one root, distinct APIs, the core imports none of them).
The rule that makes the umbrella meaningful: everything under
`composer/` is SDK-bound and app-agnostic; everything Outline-specific
(registry wiring, `$type` names and fallback compat, policy values,
`ConnectionProviderInfo` semantics) stays in the app layer under
`client/go/outline/`, and must never move under the umbrella.

Audience map: config authors read SPEC.md, never Go; strategy
developers work in `composer/netconfig` and export concrete Configs and parser
constructors; app developers read `composer/netconfig` with
`outline/configregistry` as the worked example; tooling developers need
only the core + SPEC.md.

## D15. Multi-category registry and application parser wrapping

The multi-category registry lives in `composer/registry`, one layer
above the YAML node and `TypeParser` mechanics in `composer`. Keeping
the layers in separate packages avoids overloading the existing
`composer.Kind` YAML-node-shape type with the unrelated typed extension
point identity. The rest of this section uses `registry` for the
`composer/registry` package.

The fundamental extension operation is a strongly typed registration:

```go
registry.Register(registrar, kind, typeName, parseFunc)
```

`registry.Kind[T]` identifies an extension point and carries its result
type; `composer.ParseFunc[T]` must match it. This relationship provides
the important compiler check. Parser dependencies are obtained with the
same strong typing:

```go
parseStreamDialer := registry.Parser(registrar, StreamDialerKind)
```

The returned parser is passed to a parser constructor and captured for
later use. It is late-bound so registration order does not matter and
recursive categories work.

Direct registration is the fundamental API. Reusable strategy packages expose
concrete Config types and parser constructors; they do not bundle
registrations, choose names, or know application metadata. The application
keeps the name, concrete parser constructor, parser options, metadata callback,
and `registry.Register` call at one registration site. For example:

```go
registry.Register(r, netconfig.StreamEndpointKind, "websocket",
    streamEndpointParser(
        netconfig.NewWebsocketEndpointParser(
            registry.Parser(r, netconfig.StreamEndpointKind),
            netconfig.WithWebsocketHeaders(outlineHeaders)),
        websocketInfo))
```

The app-local `streamEndpointParser` adapter requires a metadata callback. It
calls the concrete parser, computes and records the result's metadata in the
per-parse Outline collector, and returns that same concrete Config widened to
`StreamEndpointConfig`. Equivalent adapters cover the other typed Kinds and
whole transports. They wrap parsers, not Config objects, and do not inspect
private `registry.Registration` fields.

A parser constructor may be used more than once with different application
names or options:

```go
parseA := netconfig.NewWebsocketEndpointParser(parseEndpoint,
    netconfig.WithWebsocketHeaders(headersA))
parseB := netconfig.NewWebsocketEndpointParser(parseEndpoint,
    netconfig.WithWebsocketHeaders(headersB))
registry.Register(r, netconfig.StreamEndpointKind, "websocket-a",
    streamEndpointParser(parseA, websocketInfo))
registry.Register(r, netconfig.StreamEndpointKind, "websocket-b",
    streamEndpointParser(parseB, websocketInfo))
```

Composer has no plugin object, `AddPlugin`, installation lifecycle, or
metadata decoration API. Those abstractions should be added only if a
real requirement introduces identity, manifests, transactional
installation, enable/disable, permissions, or lifecycle callbacks.

`registry.Composer` and `registry.Registrar` are two interface views of
the same concrete registry; they are not separate objects and do not
imply a freeze step. `Registrar` is used in registration signatures and
can both add a strategy and provide its typed parser dependencies.
`Composer` is the registration-free view used by code that only obtains
parsers and composes configs. The separation is about capability and
API intent, not concurrent registration and parsing.

The typed public surface is:

```go
func NewKind[T any](name string) Kind[T]
func New() Registrar
func Parser[T any](Composer, Kind[T]) composer.ParseFunc[T]
func Register[T any](Registrar, Kind[T], TypeName, composer.ParseFunc[T]) error
func RegisterFallback[T any](Registrar, Kind[T], composer.ParseFunc[T]) error
```

`RegisterFallback` explicitly preserves each category's application-
specific `$type`-less behavior; an empty `TypeName` is not a magic
fallback name. Duplicate type or fallback registration returns an
error. Registration is deliberately non-transactional: if an application
registers a strategy under several Kinds and a later call fails, earlier calls
remain installed. Rollback is not part of the registry contract.

Go does not support independently generic interface methods. The
`Composer.Compose(ParseRequest)` and `Registrar.Register(Registration)`
methods therefore carry opaque type-erased requests. Their inspection
methods let an external wrapper observe and delegate composition or
registration, but constructing and extracting results stays inside the
generic free functions. Values are erased into private typed boxes, so
nil interface results and the association between a `Kind[T]` and
`ParseFunc[T]` survive the seam. Each kind's dispatcher reuses
`composer.TypeParser[any]`, including its built-in `first-supported`
semantics; ordinary registration code never handles `any`.

There is no `Use` middleware or separate `RegisterConfig` operation.
Parsers can be wrapped explicitly before registration. Composer itself has no
metadata collector or global decoration API; Outline's collector and adapters
live in `outline/configregistry` because their semantics are application-owned.

The production Outline wiring validates this design.
`composer/netconfig` owns the five typed networking Kinds alongside the
config interfaces they describe, concrete Config types, and parser
constructors. `outline/configregistry.Register` chooses Outline's names and
options, attaches required metadata callbacks, installs compatibility
fallbacks directly, and registers app-only IP-table and whole-transport
parsers.

The resulting lifecycle is:

```text
YAML → wrapped parsers build typed graph and collect app metadata → runtime build
```

1. **Strategy definition:** registration installs long-lived
   wrapped parser functions. A parser may capture other typed parser functions.
2. **Config and metadata instance:** each parse or dynamic-config refresh
   creates a per-parse Outline collector and invokes those functions. Children
   are parsed and recorded before parent metadata callbacks read them.
   `first-supported` returns the selected Config unchanged, so its existing
   metadata entry remains valid. Missing child or root metadata is an internal
   wiring error.
3. **Runtime instance:** the config graph's `New*` methods recursively
   build the actual dialers, endpoints, and listeners for a client or
   session.

The same registry and registered strategy definitions can be reused
across config refreshes; only the config and runtime graphs need to be
recreated.

## Open design: fetched config values and dynamic access keys

This section records a direction to explore, not a settled wire-format
decision. In particular, `$ref` syntax and general reference, selection,
merge, and overlay semantics remain deferred.

We want an explicit config representation for fetching another config
value. A possible shape is:

```yaml
$type: fetch
url: https://config.example/stream-dialer.yaml
```

`fetch` would replace the complete value at the point where it appears.
The surrounding parser supplies the expected type, so the fetched
document could be a whole transport, a stream dialer, or another typed
extension point. Reusable partial values such as IP-prefix or domain
sets may become their own parser categories, allowing the same fetch
representation there without introducing an untyped reference system.
Fetch would not initially select a path within a document or merge
local fields into the fetched value.

Dynamic Access Keys should use this same representation rather than a
separate fetch mechanism. The current URL form can remain a compact
shorthand that normalizes to a fetch config. A future dynamic key may
instead carry a short JSON/YAML config blurb, which would allow fetch
behavior to be extended without adding a new access-key syntax for each
fetch option. The exact encoding of a structured blurb inside an access
key, including escaping and versioning, is still open.

The capability used to execute a fetch is deliberately undecided. The
host application should inject it rather than Composer constructing its
own default HTTP client. Candidates include a dedicated fetch function
or interface, an `http.RoundTripper`-like capability, or an existing
Composer transport/dialer so fetching can inherit application routing
and protection behavior. This must fit the registration API: a fetch
helper consumes the injected capability and may register the fetch form
for multiple parser categories. We should decide the capability
boundary only after working through redirects, authentication, proxy
routing, platform socket protection, and testability.

Caching is required but its API and owner remain open with the fetch
capability. The design should be able to use HTTP freshness and
validation semantics, including conditional requests, while treating
the URL and fetched body as credential-bearing data. Any persistent
cache must be scoped to the service, safe for credentials at rest,
removed with that service's storage, and must not expose URLs, headers,
or response bodies through logs or cache filenames. An in-memory-only
cache is the safe fallback until credential-safe persistence exists.

Resolution also needs explicit limits and provenance: cancellation and
deadlines, response and aggregate byte limits, recursion depth, cycle
detection, redirect policy, relative-URL bases, and source-aware errors
for fetched documents. Fetch or network failures are operational errors;
they should not become `errors.ErrUnsupported`. An unsupported type in
the successfully fetched value may retain `ErrUnsupported`, allowing an
enclosing `first-supported` to continue according to its existing
rules.

Questions to settle in a follow-up design session:

- What is the smallest injected capability that works across the native
  apps and the future SDK: fetcher, HTTP round tripper, or Composer
  dialer/transport?
- Is fetch enabled for every declared parser category or opted into per
  category?
- What is the canonical structured Dynamic Access Key representation,
  and how does the existing `ssconf://` URL shorthand normalize to it?
- Which component owns HTTP cache policy and credential-safe persistent
  storage, and what are the stale/offline semantics?
- How do fetched source identity and selection information appear in
  annotations, diagnostics, and telemetry without leaking credentials?

## Spike findings (2026-07, goccy/go-yaml v1.18.0)

The canary tests in `goccy_test.go` pin the library behaviors the
design relies on. Findings vs the original assumptions:

- Mappings always parse as `*ast.MappingNode`, regardless of size,
  style, or nesting. (Older goccy used `*ast.MappingValueNode` for
  single-pair mappings; `mappingEntries` keeps a defensive case.)
- `IntegerNode.Value` is `uint64` for ALL non-negative integers, even
  small ones, and `int64` for negative ones. Both decoder paths handle
  both representations.
- `yes`/`no` parse as strings (YAML 1.2 semantics), so the SPEC's
  "only true/false are bool" rule needs no extra enforcement.
- A trailing `?` is part of a plain YAML key (`padding?:` works).
- Block-literal chomping is already applied to the AST string value.
- goccy rejects an anchor whose value is an alias (`&x *x`) at parse
  time, so direct alias chains cannot be constructed; composer's
  `maxAliasDepth` guard is defense-in-depth behind that.
- Composer resolves anchors document-globally, so aliases may reference
  anchors defined later in the document — deliberately more lenient
  than the YAML spec's define-before-use rule.
