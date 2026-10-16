# App-Policy Separation for Composer Parsers — Design

Status: Historical design, superseded 2026-07-20.
Depends on: the `composer` core (`client/go/composer`, PR #2801).

> This document records the initial side-table design. The implemented
> architecture also collects connection metadata in a per-parse side table,
> populated by Outline registration wrappers as configs are parsed. (An interim
> revision replaced this with a post-parse `configregistry.ConnectionAnalyzer`
> and no table; that was removed, so an earlier version of this note describing
> it is itself superseded.) Specifics differ from this document — e.g. the
> collector is context-only and direct-address resolution is a separate
> concern. See `client/go/composer/DESIGN.md` and
> `client/go/outline/configregistry/README.md` for the authoritative current
> design.

## Problem

Three pieces of Outline application policy currently live inside config
parsers, which blocks moving the parsers to the Outline SDK:

1. **Connection metadata** — `ConnectionProviderInfo` (ConnType +
   FirstHop) is computed manually inside every parser and consumed by
   `parse.go`/the TypeScript UI. It is compositional: websocket derives
   it from its inner endpoint, iptable aggregates its entries.
2. **Outline DNS interception** — `wrapTransportPairWithOutlineDNS`
   (hardcoded resolvers, link-local intercept, UDP health switching) is
   called inside the `tcpudp` parser and the legacy shadowsocks
   transport fallback.
3. **User-Agent injection** — the websocket parser hardcodes the
   Outline user agent into handshake headers.

Goal: parsers become app-agnostic and SDK-ready; Outline keeps all
three behaviors, attached from the app layer.

## Core decisions

### D1. Two-phase: parsers compose Configs; Build is explicit

Parsers no longer return live dialers/endpoints. They return **typed
config objects** with a `New` method (parse = validate + compose;
`New(ctx)` = construct):

```go
type StreamDialerConfig interface {
	NewStreamDialer(ctx context.Context) (transport.StreamDialer, error)
}
// Same pattern: PacketDialerConfig, StreamEndpointConfig,
// PacketEndpointConfig, PacketListenerConfig.
```

Concrete config types are exported structs with typed child fields:

```go
type WebsocketEndpointConfig struct {
	URL      string
	Headers  http.Header          // generic default headers, app-settable
	Endpoint StreamEndpointConfig // typed child: the tree is navigable
}

func (c *WebsocketEndpointConfig) NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error)
```

Consequences:

- **Pointer receivers are mandatory** on `New` methods so only `*T`
  satisfies the config interfaces. This guarantees the pointer-identity
  keys the metadata table (D3) relies on.
- Parse-time side effects move into `New` (random DNS-resolver
  selection, cookie-jar directory creation). Parsing becomes pure:
  `parse.go`'s first-hop endpoint can answer without building a client.
- One config type may implement several interfaces (websocket serves
  stream and packet endpoints from the same struct).

### D2. Dependencies are captured at parse time

Leaf parsers close over their dependencies when the registry is built
(as today): `DirectStreamDialerConfig` holds the base TCP dialer in an
unexported field; `New(ctx)` takes no dependency arguments. Trade-off
accepted: a parsed tree cannot be re-built against different base
dialers; re-parse instead.

### D3. Connection metadata via a per-parse side table

The pattern is `go/ast` + `go/types.Info`: the tree stays pure; computed
facts hang off node identity in a side table.

- New app package `connmeta`:

```go
ctx, table := connmeta.WithTable(context.Background())
cfg, err := transports.Parse(ctx, rootNode)
info, ok := table.Get(cfg) // missing at root = wiring bug: fail loudly
```

- Outline registers every config type through a wrapper helper: it runs
  the netconfig parser, computes `ConnectionProviderInfo` for the node
  (reading children's entries from the table — parsing is post-order,
  so children are always present), and stores it under the config
  pointer. Each wrapper reads its config type's fields directly; no
  reflection, no `Children()` interface.
- `first-supported` needs no wrapper: it returns the chosen option's
  config unchanged, so pointer identity passes the metadata through.
- The table is created per parse call and carried in `ctx` (a
  registry-scoped table would race across concurrent parses). The raw
  `context.WithValue` is encapsulated behind the typed `connmeta` API.
- **Missing-entry policy**: a lookup miss at the root is an internal
  error, surfaced loudly. Never default to "direct" — mislabeling
  tunneled traffic as direct is the dangerous direction.
- **Mutate-don't-copy rule**: tree transforms must modify nodes in
  place; a copied node silently orphans its metadata. Enforced by
  convention and covered by a test.
- `ConnType`, its enum values, and the JSON mapping to the TypeScript
  UI stay app-side, unchanged.

### D4. The three policies, relocated

| Policy | Today | After |
|---|---|---|
| FirstHop/ConnType | inside every parser | app registration wrappers + `connmeta` table |
| User-Agent | hardcoded in websocket parser | Outline passes default headers when constructing the netconfig websocket parser (generic option; the UA value never enters netconfig) |
| DNS interception | inside `tcpudp` + legacy-ss parsers | `TransportPairConfig.New` returns plain `{StreamDialer, PacketListener}`; `client.go` applies the relocated Outline DNS wrap and builds the PacketRelay |

### D5. Layering

- `client/go/composer` — format core. **No changes required** by this
  design (no annotations, no reflection walker).
- `client/go/netconfig` (new, SDK-bound) — config interfaces, concrete
  config types per protocol (shadowsocks incl. URL forms, websocket,
  dial, block, direct), and their composer parsers. Depends only on
  composer + outline-sdk. (Alternative name considered: `strategies`.)
- App layer (`configregistry` successor + `client.go`) — registry
  wiring, metadata wrappers, `connmeta`, DNS decoration, UA option,
  the `TransportPairConfig` type (TransportPair is an app concept),
  and the iptable parser (its dialer implementation is app-local
  today).

## Alternatives considered and rejected

- **Keep ConnectionProviderInfo in SDK output types**: bakes routing
  metadata into every SDK parser signature; the metadata is very
  type-specific and the SDK contract shouldn't force every type to
  answer it.
- **Composer annotation mechanism**: moves ConnectionProviderInfo into
  a general untyped structure — the same data, less type safety, plus a
  new framework concept. Strictly worse.
- **App-side wrapper parsers computing metadata from outside**: cannot
  see inner metadata without parallel bookkeeping; first-hop must be
  exposed from the inside out.
- **App-side type-switch tree walk (post-parse)**: workable, but
  duplicates per-type knowledge in a separate walker and needs a
  traversal mechanism; the registration wrapper computes the same facts
  at the point where type knowledge already exists.
- **Generic config types** (`WebsocketEndpointConfig[E StreamEndpointConfig]`,
  so subtypes could statically carry metadata): rejected as structurally
  unsound for this system. The `$type` registry must have a single
  output type per category, so `E` erases to the interface at every
  registry boundary and the parameterization degenerates to the
  non-generic design with extra ceremony. Runtime-chosen composition
  (websocket-over-websocket-over-…) has no static spelling of `E`.
  Haskell's "Trees That Grow" achieves typed tree decoration with type
  families and higher-kinded types; Go deliberately has neither. Go's
  own toolchain answers this exact problem with interface trees plus a
  side table (`go/ast` + `go/types.Info`).
- **Decorator wrapping** (registration wrapper returns an annotating
  struct that embeds the config interface and adds `ConnInfo()`):
  closest viable "metadata in the subtype" variant; no generics, no
  side table. Rejected because it pollutes the tree — every consumer
  that type-switches on concrete netconfig types must unwrap, and
  configs implementing multiple interfaces need wrapper variants per
  interface combination. The side table keeps the parsed tree canonical.

## Error handling

- Wrapper metadata computation failures and root-lookup misses surface
  as internal/invalid-config errors through the existing platerrors
  mapping in `client.go`.
- Composer path/position error wrapping is unaffected; wrappers add no
  new error text of their own on the happy path.

## Testing

- **netconfig**: parse → assert typed config trees (golden trees);
  `New` against fake base dialers; header-option test for websocket.
- **App layer**: per-type metadata wrapper tests (today's ConnType
  tests, e.g. iptable aggregation, relocate largely intact);
  first-supported identity-passthrough test; missing-entry-fails test;
  mutate-don't-copy regression test.
- **End-to-end**: full provider YAML → root metadata correct + built
  transport functions; `parse.go` first-hop endpoint answers without
  construction.

## Migration order

1. `netconfig` package (pure; builds alongside everything, no callers).
2. `connmeta` + metadata wrappers + new registry builder, coexisting
   with the legacy `configyaml` path.
3. `client.go`/`parse.go` switchover: two-phase parse/build, DNS
   decoration at build, metadata from the table.
4. Delete legacy `configyaml` and the old configregistry parsers.

Steps 1–4 are one implementation plan. The SDK move itself (lifting
composer + netconfig into outline-sdk, reconciling `x/configurl`) is a
separate effort in the SDK repo.
