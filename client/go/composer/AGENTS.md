# The `composer` Package (Outline Composer)

Core of Outline's extensible configuration system: the notation and
toolkit that lets anyone compose network strategies. Read SPEC.md for
the wire format (normative) and DESIGN.md for why things are the way
they are.

## Adding a new config type

1. Define a plain Go struct. No tags. Fields are required unless typed
   `composer.Optional[T]`. Use `composer.Node` for delegated sub-configs.
2. Write a build function `func(ctx context.Context, cfg MyConfig) (T, error)`.
   If it delegates, take the needed `composer.ParseFunc` as a constructor
   argument so the dependency is explicit and compile-checked.
3. Export the concrete Config type and parser constructor. The consuming
   application registers that parser under its contract owner's typed Kind
   with `registry.Register`, choosing the `$type` name and attaching any
   application metadata or policy there. For a standalone legacy
   `TypeParser[T]`, `composer.RegisterParser` remains available.

Keep application policy (metadata, DNS behavior, User-Agent) out of this
package; it is destined for the Outline SDK and must stay app-agnostic.

## Status

Complete. The legacy `client/go/configyaml` package has been deleted;
every parser now lives on top of `composer`. `client/go/composer/netconfig` is
the transport layer built on this package — config interfaces
(`StreamDialerConfig` etc.), concrete config types, and their parsers,
kept free of Outline application policy so it can move to the Outline
SDK. `client/go/outline/configregistry` is the app layer: it chooses
netconfig `$type` names and fallbacks, wraps registered parsers to collect
connection metadata while the typed graph is built, and applies
Outline-specific policy (User-Agent, address resolution, DNS interception)
that must not live in this package or in netconfig.
See netconfig/AGENTS.md and configregistry/README.md.
