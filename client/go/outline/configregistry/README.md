# Outline Config Registry

`configregistry` is the Outline-owned layer above Composer and
`composer/netconfig`. It chooses Outline's `$type` names and compatibility
fallbacks, defines app-only transport configs, attaches connection metadata,
and applies Outline transport policy.

The reusable layers below this package expose typed Configs and concrete parser
constructors. They do not know Outline's registered names,
`ConnectionProviderInfo`, compatibility forms, User-Agent, DNS interception,
or platform address-resolution policy.

## Lifecycle

The client config lifecycle is:

```text
YAML → wrapped parsers build typed graph and collect app metadata → runtime build
```

1. `ClientParser.Parse` seeds the parse context with `WithMetadataCollection`
   (and `WithDirectDialResolution`), then invokes the registry's whole-transport
   parser. The per-parse metadata side table is reached only through the context.
2. Each Outline registration wraps one concrete parser. After that parser has
   successfully produced its canonical netconfig Config, the wrapper computes
   metadata from the Config and already-recorded child metadata, stores the
   result, and widens the original Config to its typed Kind interface. No
   decorator Configs are returned.
3. `ClientParser.Parse` retrieves the root metadata with
   `TransportMetadata(ctx, cfg)`. Missing root or child metadata is an internal
   registration-wiring error, never an implicit direct connection.
4. `ClientConfig.New` recursively builds runtime dialers and listeners,
   then applies Outline's DNS interception.

`first-supported` needs no metadata wrapper of its own: it returns the selected
Config object unchanged, and that object's concrete parser has already stored
its metadata. The collector is per parse, so a Composer and its long-lived
parser registrations can be reused safely across sequential config refreshes.

## Registration

`Register` keeps named registrations sorted by `$type`: `basic-access`,
`block`, `dial`, `direct`, `iptable`, `shadowsocks`, `tcpudp`, and
`websocket`. Unnamed compatibility fallbacks are grouped afterward.

Every registration site shows the app-chosen name, concrete parser
constructor, required metadata callback, and any app option such as Outline's
WebSocket User-Agent. This deliberately keeps protocol syntax in netconfig and
Outline semantics at the application boundary. Netconfig has no multi-protocol
`Register…` helpers and no canonical wire names; the same parser constructor
can be registered more than once with different names or options.

The metadata-aware parser adapters cover all five netconfig Kinds and the
app-owned whole-transport Kind. They record metadata and return the original
concrete Config widened to the requested interface. They do not inspect private
`registry.Registration` state.

## Metadata behavior

- Direct configs are direct with no first hop; block configs are blocked.
- Dial endpoints inherit their child dialer's type. A direct child makes the
  endpoint address the first hop and resolves it under Outline's platform
  policy; a tunneled child leaves the address untouched and preserves its first
  hop.
- WebSocket inherits its inner stream endpoint metadata.
- Shadowsocks stream, packet-dialer, and packet-listener forms are tunneled and
  preserve their endpoint's first hop.
- IP table preserves the blocked/direct/tunneled/partial aggregation semantics
  and deliberately leaves first hop empty.
- TCP/UDP transports collect stream and packet metadata independently. The
  legacy Shadowsocks transport collects both sides; Basic Access marks both
  sides direct.

On Linux and Windows, production parsing resolves a direct endpoint once per
parse and rewrites `Address` to that stable result. The stream and packet halves
share the collector's resolution cache, so `FirstHop` is the address the
runtime dials and a platform bypass route can cover it exactly. netconfig itself
never resolves; this rewrite is the only resolution. Resolution failure is
non-fatal: the hostname remains and the runtime dialer resolves it at dial time.
Tests disable external DNS unless they inject a resolver.

## Adding a config type

Generic protocol Configs and parser constructors belong in
`composer/netconfig`; they must not choose a `$type` name or import this
package. Add each Outline registration directly in `Register` with a metadata
callback for every Kind it implements. A parent callback must use
`requireConnectionInfo` for parsed children, so a missing child wrapper fails
as an internal wiring error.

Outline-only Configs and compatibility behavior belong here. Whole transports
use `TransportPairInfo`, while dialers, endpoints, and listeners use
`ConnectionProviderInfo`.

## Testing

- `metadata_test.go` covers metadata for every protocol/config form, all Kinds
  and fallbacks, `first-supported`, missing collectors/children, resolution
  policy and memoization, and repeated parser-option isolation.
- `transport_test.go`, `corpus_test.go`, and `iptable_config_test.go` preserve
  legacy URLs/mappings, prefixes, documented YAML (including anchors), exact
  aggregation, and runtime dispatch behavior.
- `client_test.go` verifies missing custom top-level metadata is surfaced as an
  internal error and that parsing still does not build runtime resources.
