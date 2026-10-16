# The `netconfig` Package

The transport contract layer of Outline Composer: config interfaces
(`StreamDialerConfig`, `PacketDialerConfig`, `StreamEndpointConfig`,
`PacketEndpointConfig`, `PacketListenerConfig`, all in interfaces.go),
their shared typed `registry.Kind[T]` extension points, concrete config
types, and parser constructors — one
file per protocol (direct.go, block.go, dialendpoint.go, websocket.go,
shadowsocks.go). Built on `client/go/composer`; read its SPEC.md (wire
format) and AGENTS.md (parser mechanics) first. Consumed by the Outline
app layer at `client/go/outline/configregistry` — read that package's
README.md for how these pieces are named, annotated, and assembled into
a client.

## Two-phase: parse, then `New`

A parser only composes a typed config object; it does no I/O and has no
side effects. Each config type has a `New*(ctx)` method — `NewStreamDialer`,
`NewStreamEndpoint`, etc. — that builds the runtime object. That's where
dependencies actually get invoked. Keeping parse pure lets a caller
inspect a parsed tree — e.g. read the first-hop endpoint address —
without building anything. This package performs no DNS at any stage: a dial
endpoint dials its `Address` exactly as it finds it. An application that needs
the dialed address resolved rewrites `Address` on the parsed config first.

Many `New*` methods take pointer receivers because their config values or
builders are naturally pointer-backed. Outline's per-parse metadata side table
is entirely app-owned; this package neither creates nor reads it.

## Registration API

The reusable API is the Config types and concrete parser constructors.
Applications register those parsers directly with `registry.Register`, so the
registered name, parser options, and application metadata callback remain
together at the application boundary. A parser constructor never knows the
name under which its result will be registered and can be reused under
different names or with different options.

## The no-app-imports rule

This package is destined for the Outline SDK (see `composer/DESIGN.md`
D12). It must never import an Outline application package
(`localhost/client/go/outline/...`), and it must never encode Outline
application policy:

- No `ConnectionProviderInfo` or other connection metadata — the app layer
  wraps each registered parser and records metadata as it builds the typed
  config graph.
- No hardcoded User-Agent. `NewWebsocketEndpointParser` takes generic
  `WithWebsocketHeaders(...)` options; the caller (`outline/configregistry`)
  supplies the actual Outline User-Agent string.
- No DNS interception, cookie-jar paths, or other Outline-specific
  behavior — a `TransportPairConfig`-style aggregate type and any DNS
  wrapping belong in the app layer.
- No address resolution. `StreamDialEndpointConfig` and
  `PacketDialEndpointConfig` dial `Address` verbatim and never do DNS. An
  application that needs the dialed address to be an IP resolves it and
  rewrites `Address` on the parsed config — e.g. because a platform installs a
  bypass route for that address, or because its protected-socket routing can't
  tolerate unprotected system DNS at dial time (see the Outline registration
  callback in `outline/configregistry`).

## Adding a new config type

1. Define the config struct with `New*(ctx)` method(s) (pointer
   receiver) implementing the relevant interface(s) from
   interfaces.go.
2. Write a parser: a plain `func(ctx context.Context, node composer.Node)
   (*MyConfig, error)` if it stands alone (see `ParseBlock`), or a
   constructor returning one — `NewMyConfigParser(parseChild
   composer.ParseFunc[OtherConfig], opts ...MyConfigOption)
   composer.ParseFunc[*MyConfig]` — if it delegates to another
   category's parser or takes options (see `NewWebsocketEndpointParser`,
   `NewShadowsocksStreamDialerParser`). Delegated dependencies are
   explicit `composer.ParseFunc` constructor arguments, per
   composer/AGENTS.md.
3. Export the concrete Config and parser constructor. Keep `$type` names,
   fallbacks, application options, and metadata out of this package; the
   consuming application supplies all of them at its registration site.

## Where new code belongs: here vs. the app layer

Add it here if it's generic transport behavior any Outline Composer
consumer could use: a new protocol, a new dial/endpoint shape, a new
wrapping transport. Add it in `outline/configregistry` instead if it
needs Outline application state or policy — `ConnectionProviderInfo`, a
User-Agent value, DNS interception, data-directory paths, or anything
that reads from an app-only package like `iptable` or `reporting`.

## Status

Complete. netconfig is the sole transport-config layer for the Outline
client; the legacy `client/go/configyaml` package it replaced has been
deleted.
