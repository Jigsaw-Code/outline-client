# Composer Migration Implementation Plan

> Historical plan: completed and subsequently reworked in part. The current
> architecture uses `composer/registry` and collects connection metadata in a
> per-parse side table populated by Outline registration wrappers — close in
> spirit to what this plan describes below, though the details differ (the
> collector is context-only, direct-address resolution is a separate concern,
> and `netconfig` exposes parser constructors directly with no `Register…`
> helpers). An interim revision replaced the side table with a post-parse
> `configregistry.ConnectionAnalyzer`; that was removed. See
> `client/go/composer/DESIGN.md` and
> `client/go/outline/configregistry/README.md` for the current design.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the client's config system from `configyaml`/legacy `configregistry` parsers onto the `composer` core, per the approved design in `docs/superpowers/specs/2026-07-08-app-policy-separation-design.md`: SDK-ready parsers in a new `netconfig` package, app policy attached via a `connmeta` side table and registration wrappers, DNS/UA policy relocated, then legacy deletion.

**Architecture:** Two-phase configs: parsers compose typed Config objects (`New(ctx)` builds the runtime object); dependencies are captured at parse time. `netconfig` (SDK-bound) holds config interfaces, concrete config types, and composer parsers with zero Outline-app imports. The app layer (`configregistry` + `client.go`) wires registries, decorates each registration with a metadata computation stored in a per-parse `connmeta` table keyed by config pointer identity, injects User-Agent via a parser option, and applies the Outline DNS wrap after build.

**Tech Stack:** Go (repo module `localhost`), `client/go/composer` (from PR #2801), outline-sdk (`transport`, `shadowsocks`, `websocket`, `tlsfrag`, `packetrelay`, `dnsintercept`, `dnstruncate`), testify.

## Global Constraints

- Run all commands from repo root `/Users/fortuna/code/outline-apps`. Tests: `go test ./client/go/...`.
- `client/go/composer` is frozen for this plan: no changes to the composer core.
- `client/go/netconfig` must import only `composer`, the outline-sdk, and stdlib — zero `localhost/client/go/outline/...` imports.
- Pointer receivers on all `New*` config methods (only `*T` satisfies the interfaces — pointer identity is required by connmeta).
- gobind-visible signatures preserved exactly: `Client` methods (`DialStream`, `NewAssociation`, `NotifyNetworkChanged`, `StartSession`, `EndSession`), `ClientConfig.New(keyID, providerClientConfigText string) *NewClientResult`, `NewClientResult` fields.
- TypeScript contract unchanged: `firstHopAndTunnelConfigJSON` field names and `ConnType` JSON strings (`direct`/`tunneled`/`partial`/`blocked`).
- Missing connmeta entry at a root lookup is a loud error; never default to direct.
- Every new Go file starts with the repo's 13-line Apache header (year 2026).
- `gofmt -w` + `go vet ./client/go/...` clean before each commit. Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Legacy behavior is the spec: when porting a parser, port its `_test.go` cases too (adapting API), and keep semantics identical unless this plan states a deliberate change (parse-time side effects move to build).

## File Structure

- `client/go/netconfig/` — `doc.go`, `interfaces.go`, `direct.go`, `block.go`, `dialendpoint.go`, `websocket.go`, `shadowsocks.go` (+ `_test.go` each; `AGENTS.md` in Task 13).
- `client/go/outline/connmeta/` — `connmeta.go` + test.
- `client/go/outline/configregistry/` — new: `composer_registry.go`, `iptable_config.go`, `transport_configs.go`, `outline_dns.go`, `corpus_test.go` (+ tests). Legacy files deleted in Task 12.
- `client/go/outline/reporting/config.go` — ported to composer.
- `client/go/outline/client.go`, `parse.go`, `electron/main.go`, `vpn_linux.go` — switchover.

---

### Task 1: netconfig package — interfaces, direct, block

**Files:**
- Create: `client/go/netconfig/doc.go`, `client/go/netconfig/interfaces.go`, `client/go/netconfig/direct.go`, `client/go/netconfig/block.go`
- Test: `client/go/netconfig/block_test.go`

**Interfaces:**
- Produces (used by every later task):

```go
type StreamDialerConfig interface { NewStreamDialer(ctx context.Context) (transport.StreamDialer, error) }
type PacketDialerConfig interface { NewPacketDialer(ctx context.Context) (transport.PacketDialer, error) }
type StreamEndpointConfig interface { NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error) }
type PacketEndpointConfig interface { NewPacketEndpoint(ctx context.Context) (transport.PacketEndpoint, error) }
type PacketListenerConfig interface { NewPacketListener(ctx context.Context) (transport.PacketListener, error) }

func NewDirectStreamDialerConfig(d transport.StreamDialer) *DirectStreamDialerConfig
func NewDirectPacketDialerConfig(d transport.PacketDialer) *DirectPacketDialerConfig
func NewDirectPacketListenerConfig(l transport.PacketListener) *DirectPacketListenerConfig
type BlockConfig struct{}   // implements StreamDialerConfig and PacketDialerConfig
func ParseBlock(ctx context.Context, node composer.Node) (*BlockConfig, error)
```

- [ ] **Step 1: Write the failing test**

`client/go/netconfig/block_test.go` (Apache header on every file; omitted in plan listings):

```go
package netconfig

import (
	"context"
	"testing"

	"localhost/client/go/composer"
	"github.com/stretchr/testify/require"
)

func mustNode(t *testing.T, text string) composer.Node {
	t.Helper()
	n, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	return n
}

func TestBlockConfig(t *testing.T) {
	cfg, err := ParseBlock(context.Background(), mustNode(t, "$type: block"))
	require.NoError(t, err)

	sd, err := cfg.NewStreamDialer(context.Background())
	require.NoError(t, err)
	_, err = sd.DialStream(context.Background(), "example.com:443")
	require.ErrorContains(t, err, "blocked by config")

	pd, err := cfg.NewPacketDialer(context.Background())
	require.NoError(t, err)
	_, err = pd.DialPacket(context.Background(), "example.com:443")
	require.ErrorContains(t, err, "blocked by config")
}

func TestBlockConfig_RejectsUnknownFields(t *testing.T) {
	_, err := ParseBlock(context.Background(), mustNode(t, "$type: block\nwat: 1"))
	require.Error(t, err)
}

func TestDirectConfigs(t *testing.T) {
	base := &transport.TCPDialer{}
	cfg := NewDirectStreamDialerConfig(base)
	sd, err := cfg.NewStreamDialer(context.Background())
	require.NoError(t, err)
	require.Same(t, base, sd)
}
```

Add `"golang.getoutline.org/sdk/transport"` to imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./client/go/netconfig/... 2>&1 | tail -5`
Expected: FAIL (package does not exist / undefined symbols).

- [ ] **Step 3: Implement**

`client/go/netconfig/doc.go`:

```go
// Package netconfig provides Outline Composer config types and parsers
// for network strategies (dialers, endpoints, listeners). Parsing
// composes typed Config objects; calling a Config's New method builds
// the runtime object. This package is destined for the Outline SDK and
// must not import Outline application packages.
package netconfig
```

`client/go/netconfig/interfaces.go`:

```go
package netconfig

import (
	"context"

	"golang.getoutline.org/sdk/transport"
)

// StreamDialerConfig is a parsed strategy that can build a StreamDialer.
type StreamDialerConfig interface {
	NewStreamDialer(ctx context.Context) (transport.StreamDialer, error)
}

// PacketDialerConfig is a parsed strategy that can build a PacketDialer.
type PacketDialerConfig interface {
	NewPacketDialer(ctx context.Context) (transport.PacketDialer, error)
}

// StreamEndpointConfig is a parsed strategy that can build a StreamEndpoint.
type StreamEndpointConfig interface {
	NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error)
}

// PacketEndpointConfig is a parsed strategy that can build a PacketEndpoint.
type PacketEndpointConfig interface {
	NewPacketEndpoint(ctx context.Context) (transport.PacketEndpoint, error)
}

// PacketListenerConfig is a parsed strategy that can build a PacketListener.
type PacketListenerConfig interface {
	NewPacketListener(ctx context.Context) (transport.PacketListener, error)
}
```

`client/go/netconfig/direct.go`:

```go
package netconfig

import (
	"context"

	"golang.getoutline.org/sdk/transport"
)

// DirectStreamDialerConfig wraps a base dialer captured at registry
// construction. Its identity (the pointer) is how apps recognize
// direct access in a parsed tree.
type DirectStreamDialerConfig struct {
	dialer transport.StreamDialer
}

func NewDirectStreamDialerConfig(d transport.StreamDialer) *DirectStreamDialerConfig {
	return &DirectStreamDialerConfig{dialer: d}
}

func (c *DirectStreamDialerConfig) NewStreamDialer(ctx context.Context) (transport.StreamDialer, error) {
	return c.dialer, nil
}

type DirectPacketDialerConfig struct {
	dialer transport.PacketDialer
}

func NewDirectPacketDialerConfig(d transport.PacketDialer) *DirectPacketDialerConfig {
	return &DirectPacketDialerConfig{dialer: d}
}

func (c *DirectPacketDialerConfig) NewPacketDialer(ctx context.Context) (transport.PacketDialer, error) {
	return c.dialer, nil
}

type DirectPacketListenerConfig struct {
	listener transport.PacketListener
}

func NewDirectPacketListenerConfig(l transport.PacketListener) *DirectPacketListenerConfig {
	return &DirectPacketListenerConfig{listener: l}
}

func (c *DirectPacketListenerConfig) NewPacketListener(ctx context.Context) (transport.PacketListener, error) {
	return c.listener, nil
}
```

`client/go/netconfig/block.go`:

```go
package netconfig

import (
	"context"
	"errors"

	"localhost/client/go/composer"
	"golang.getoutline.org/sdk/transport"
)

// BlockConfig refuses all connections. It implements both
// StreamDialerConfig and PacketDialerConfig.
type BlockConfig struct{}

func (c *BlockConfig) NewStreamDialer(ctx context.Context) (transport.StreamDialer, error) {
	return transport.FuncStreamDialer(func(ctx context.Context, addr string) (transport.StreamConn, error) {
		return nil, errors.New("blocked by config")
	}), nil
}

func (c *BlockConfig) NewPacketDialer(ctx context.Context) (transport.PacketDialer, error) {
	return transport.FuncPacketDialer(func(ctx context.Context, addr string) (net.Conn, error) {
		return nil, errors.New("blocked by config")
	}), nil
}

// ParseBlock parses the `block` strategy (no fields).
func ParseBlock(ctx context.Context, node composer.Node) (*BlockConfig, error) {
	var cfg struct{}
	if err := node.Decode(&cfg); err != nil {
		return nil, err
	}
	return &BlockConfig{}, nil
}
```

Add `"net"` import. Check the SDK for `transport.FuncPacketDialer`; if it does not exist, define a tiny local adapter type in `block.go`:

```go
type funcPacketDialer func(ctx context.Context, addr string) (net.Conn, error)

func (f funcPacketDialer) DialPacket(ctx context.Context, addr string) (net.Conn, error) {
	return f(ctx, addr)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./client/go/netconfig/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/netconfig && git add client/go/netconfig
git commit -m "feat(client/go): add netconfig package with direct and block configs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: netconfig dial endpoints

**Files:**
- Create: `client/go/netconfig/dialendpoint.go`
- Test: `client/go/netconfig/dialendpoint_test.go`

**Interfaces:**
- Consumes: `StreamDialerConfig`, `PacketDialerConfig` (Task 1).
- Produces:

```go
type StreamDialEndpointConfig struct {
	Address             string
	ResolveAddressFirst bool // app policy flag: resolve Address before dialing
	Dialer              StreamDialerConfig
}
func (c *StreamDialEndpointConfig) NewStreamEndpoint(ctx) (transport.StreamEndpoint, error)
type PacketDialEndpointConfig struct { Address string; ResolveAddressFirst bool; Dialer PacketDialerConfig }
func (c *PacketDialEndpointConfig) NewPacketEndpoint(ctx) (transport.PacketEndpoint, error)
func NewStreamDialEndpointParser(parseSD composer.ParseFunc[StreamDialerConfig]) composer.ParseFunc[*StreamDialEndpointConfig]
func NewPacketDialEndpointParser(parsePD composer.ParseFunc[PacketDialerConfig]) composer.ParseFunc[*PacketDialEndpointConfig]
```

Behavior notes (from legacy `config_dial_endpoint.go`):
- Accepts scalar shorthand `"host:port"` or a mapping `{address, dialer?}` (also `$type: dial`; the `$` key is skipped by Decode).
- Validates address: split host/port, non-empty host, port in 1–65535.
- `ResolveAddressFirst` is NOT parsed from config (no wire field): it is a policy flag the app sets on the parsed config. When true, `New*Endpoint` resolves `Address` once (TCP/UDP resolve; on failure, keep the hostname — recovery behavior preserved from legacy).
- The OS/testing conditions that decide the flag stay in the app (Task 6) — netconfig only honors the flag.

- [ ] **Step 1: Write the failing test**

`client/go/netconfig/dialendpoint_test.go`:

```go
package netconfig

import (
	"context"
	"net"
	"testing"

	"localhost/client/go/composer"
	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
)

// fakeStreamDialer records the address it was asked to dial.
type fakeStreamDialer struct{ gotAddr string }

func (f *fakeStreamDialer) DialStream(ctx context.Context, addr string) (transport.StreamConn, error) {
	f.gotAddr = addr
	return nil, nil
}

func parseSDForTest(fake *fakeStreamDialer) composer.ParseFunc[StreamDialerConfig] {
	direct := NewDirectStreamDialerConfig(fake)
	return func(ctx context.Context, node composer.Node) (StreamDialerConfig, error) {
		return direct, nil
	}
}

func TestStreamDialEndpoint_Scalar(t *testing.T) {
	fake := &fakeStreamDialer{}
	parse := NewStreamDialEndpointParser(parseSDForTest(fake))
	cfg, err := parse(context.Background(), mustNode(t, `"example.com:443"`))
	require.NoError(t, err)
	require.Equal(t, "example.com:443", cfg.Address)

	ep, err := cfg.NewStreamEndpoint(context.Background())
	require.NoError(t, err)
	_, err = ep.ConnectStream(context.Background())
	require.NoError(t, err)
	require.Equal(t, "example.com:443", fake.gotAddr)
}

func TestStreamDialEndpoint_Mapping(t *testing.T) {
	fake := &fakeStreamDialer{}
	parse := NewStreamDialEndpointParser(parseSDForTest(fake))
	cfg, err := parse(context.Background(), mustNode(t, "$type: dial\naddress: example.com:8080"))
	require.NoError(t, err)
	require.Equal(t, "example.com:8080", cfg.Address)
	require.NotNil(t, cfg.Dialer)
}

func TestStreamDialEndpoint_AddressValidation(t *testing.T) {
	parse := NewStreamDialEndpointParser(parseSDForTest(&fakeStreamDialer{}))
	for _, bad := range []string{`"example.com"`, `":443"`, `"example.com:"`, `"example.com:0"`, `"example.com:99999"`} {
		_, err := parse(context.Background(), mustNode(t, bad))
		require.Error(t, err, "address %s must be rejected", bad)
	}
}

func TestStreamDialEndpoint_ResolveAddressFirst(t *testing.T) {
	fake := &fakeStreamDialer{}
	parse := NewStreamDialEndpointParser(parseSDForTest(fake))
	cfg, err := parse(context.Background(), mustNode(t, `"localhost:443"`))
	require.NoError(t, err)
	cfg.ResolveAddressFirst = true

	ep, err := cfg.NewStreamEndpoint(context.Background())
	require.NoError(t, err)
	_, err = ep.ConnectStream(context.Background())
	require.NoError(t, err)
	// localhost resolves; the dialed address must be an IP.
	host, _, err := net.SplitHostPort(fake.gotAddr)
	require.NoError(t, err)
	require.NotNil(t, net.ParseIP(host))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./client/go/netconfig/... 2>&1 | tail -3`
Expected: FAIL (undefined: NewStreamDialEndpointParser).

- [ ] **Step 3: Implement**

`client/go/netconfig/dialendpoint.go`:

```go
package netconfig

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"

	"localhost/client/go/composer"
	"golang.getoutline.org/sdk/transport"
)

// StreamDialEndpointConfig connects to a fixed address via a dialer.
type StreamDialEndpointConfig struct {
	Address string
	// ResolveAddressFirst makes New resolve Address before dialing.
	// It has no wire field: apps set it on the parsed config (e.g. to
	// avoid unprotectable system DNS resolution at dial time on
	// platforms that route by socket mark or interface binding).
	ResolveAddressFirst bool
	Dialer              StreamDialerConfig
}

func (c *StreamDialEndpointConfig) NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error) {
	dialer, err := c.Dialer.NewStreamDialer(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build dialer: %w", err)
	}
	addr := c.Address
	if c.ResolveAddressFirst {
		// Ignore resolution failures and keep the hostname, so building
		// doesn't fail and recovery is possible when DNS comes back.
		if ipPort, err := net.ResolveTCPAddr("tcp", addr); err == nil {
			addr = ipPort.String()
		}
	}
	return transport.FuncStreamEndpoint(func(ctx context.Context) (transport.StreamConn, error) {
		return dialer.DialStream(ctx, addr)
	}), nil
}

// PacketDialEndpointConfig is the packet variant of StreamDialEndpointConfig.
type PacketDialEndpointConfig struct {
	Address             string
	ResolveAddressFirst bool
	Dialer              PacketDialerConfig
}

func (c *PacketDialEndpointConfig) NewPacketEndpoint(ctx context.Context) (transport.PacketEndpoint, error) {
	dialer, err := c.Dialer.NewPacketDialer(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build dialer: %w", err)
	}
	addr := c.Address
	if c.ResolveAddressFirst {
		if ipPort, err := net.ResolveUDPAddr("udp", addr); err == nil {
			addr = ipPort.String()
		}
	}
	return transport.FuncPacketEndpoint(func(ctx context.Context) (net.Conn, error) {
		return dialer.DialPacket(ctx, addr)
	}), nil
}

type dialEndpointFields struct {
	Address string
	Dialer  composer.Optional[composer.Node]
}

func decodeDialEndpoint(node composer.Node) (dialEndpointFields, error) {
	var f dialEndpointFields
	if node.Kind() == composer.KindScalar {
		if err := node.Decode(&f.Address); err != nil {
			return f, err
		}
	} else if err := node.Decode(&f); err != nil {
		return f, err
	}
	return f, validateAddress(f.Address)
}

func validateAddress(address string) error {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid address format: %w", err)
	}
	if host == "" {
		return errors.New("host must not be empty")
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil {
		return fmt.Errorf("invalid port number: %w", err)
	}
	if port == 0 {
		return errors.New("port must not be zero")
	}
	return nil
}

// NewStreamDialEndpointParser parses a dial endpoint: either a scalar
// "host:port" or a mapping {address, dialer?}. The dialer defaults to
// whatever parseSD yields for an absent node.
func NewStreamDialEndpointParser(parseSD composer.ParseFunc[StreamDialerConfig]) composer.ParseFunc[*StreamDialEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (*StreamDialEndpointConfig, error) {
		f, err := decodeDialEndpoint(node)
		if err != nil {
			return nil, err
		}
		dialerNode, _ := f.Dialer.Get()
		dialer, err := parseSD(ctx, dialerNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse sub-dialer: %w", err)
		}
		return &StreamDialEndpointConfig{Address: f.Address, Dialer: dialer}, nil
	}
}

// NewPacketDialEndpointParser is the packet variant of NewStreamDialEndpointParser.
func NewPacketDialEndpointParser(parsePD composer.ParseFunc[PacketDialerConfig]) composer.ParseFunc[*PacketDialEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (*PacketDialEndpointConfig, error) {
		f, err := decodeDialEndpoint(node)
		if err != nil {
			return nil, err
		}
		dialerNode, _ := f.Dialer.Get()
		dialer, err := parsePD(ctx, dialerNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse sub-dialer: %w", err)
		}
		return &PacketDialEndpointConfig{Address: f.Address, Dialer: dialer}, nil
	}
}
```

Note: `f.Dialer.Get()` yields a zero (absent) `composer.Node` when the field is missing — the registry fallback maps absent to direct, matching legacy `nil` handling. Check the SDK for `transport.FuncPacketEndpoint`; if absent, add a local adapter like Task 1's.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./client/go/netconfig/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/netconfig && git add client/go/netconfig
git commit -m "feat(client/go): add netconfig dial endpoint configs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: netconfig websocket endpoints

**Files:**
- Create: `client/go/netconfig/websocket.go`
- Test: `client/go/netconfig/websocket_test.go`

**Interfaces:**
- Consumes: `StreamEndpointConfig` (Task 1).
- Produces:

```go
type WebsocketEndpointConfig struct {
	URL      string               // normalized (ws/wss scheme)
	Headers  http.Header          // sent in the handshake; app-settable
	Endpoint StreamEndpointConfig // inner transport (packet variant also rides over a stream endpoint)
}
func (c *WebsocketEndpointConfig) NewStreamEndpoint(ctx) (transport.StreamEndpoint, error)
func (c *WebsocketEndpointConfig) NewPacketEndpoint(ctx) (transport.PacketEndpoint, error)
type WebsocketOption func(*websocketOptions)
func WithWebsocketHeaders(h http.Header) WebsocketOption
func NewWebsocketEndpointParser(parseSE composer.ParseFunc[StreamEndpointConfig], opts ...WebsocketOption) composer.ParseFunc[*WebsocketEndpointConfig]
```

Behavior from legacy `config_websocket.go`: URL scheme/port normalization (`https|wss`→`wss:443`, `http|ws`→`ws:80`); if `endpoint` absent, default to `host:port` of the URL (delegated through `parseSE` so it goes through the dial-endpoint path); both stream and packet websocket ride over a *stream* endpoint. The Outline User-Agent is NOT here — the app passes it via `WithWebsocketHeaders` (Task 6).

- [ ] **Step 1: Write the failing test**

`client/go/netconfig/websocket_test.go`:

```go
package netconfig

import (
	"context"
	"net/http"
	"testing"

	"localhost/client/go/composer"
	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
)

type fakeSE struct{}

func (fakeSE) NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error) {
	return transport.FuncStreamEndpoint(func(ctx context.Context) (transport.StreamConn, error) {
		return nil, nil
	}), nil
}

func parseSEForTest(t *testing.T, wantNode string) composer.ParseFunc[StreamEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (StreamEndpointConfig, error) {
		if wantNode != "" {
			var addr string
			require.NoError(t, node.Decode(&addr))
			require.Equal(t, wantNode, addr)
		}
		return &fakeSE{}, nil
	}
}

func TestWebsocket_ParseAndDefaults(t *testing.T) {
	// URL without endpoint: inner endpoint defaults to URL host:port.
	parse := NewWebsocketEndpointParser(parseSEForTest(t, "cdn.example.com:443"))
	cfg, err := parse(context.Background(), mustNode(t, "$type: websocket\nurl: https://cdn.example.com/tcp"))
	require.NoError(t, err)
	require.Equal(t, "wss://cdn.example.com/tcp", cfg.URL)
	require.NotNil(t, cfg.Endpoint)
}

func TestWebsocket_ExplicitEndpointAndHeaders(t *testing.T) {
	hdrs := http.Header{"User-Agent": []string{"TestAgent"}}
	parse := NewWebsocketEndpointParser(parseSEForTest(t, "backend.example.com:8443"),
		WithWebsocketHeaders(hdrs))
	cfg, err := parse(context.Background(),
		mustNode(t, "url: wss://cdn.example.com/tcp\nendpoint: backend.example.com:8443"))
	require.NoError(t, err)
	require.Equal(t, "TestAgent", cfg.Headers.Get("User-Agent"))

	// Headers are copied, not aliased: later parser calls must not share.
	cfg.Headers.Set("User-Agent", "Changed")
	cfg2, err := parse(context.Background(),
		mustNode(t, "url: wss://cdn.example.com/tcp\nendpoint: backend.example.com:8443"))
	require.NoError(t, err)
	require.Equal(t, "TestAgent", cfg2.Headers.Get("User-Agent"))
}

func TestWebsocket_InvalidURL(t *testing.T) {
	parse := NewWebsocketEndpointParser(parseSEForTest(t, ""))
	_, err := parse(context.Background(), mustNode(t, "url: \"://bad\""))
	require.Error(t, err)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./client/go/netconfig/... 2>&1 | tail -3`
Expected: FAIL (undefined: NewWebsocketEndpointParser).

- [ ] **Step 3: Implement**

`client/go/netconfig/websocket.go`:

```go
package netconfig

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"

	"localhost/client/go/composer"
	"golang.getoutline.org/sdk/transport"
	"golang.getoutline.org/sdk/x/websocket"
)

// WebsocketEndpointConfig tunnels a stream or packet connection over a
// websocket. Both variants ride over an inner stream endpoint.
type WebsocketEndpointConfig struct {
	URL      string
	Headers  http.Header
	Endpoint StreamEndpointConfig
}

func (c *WebsocketEndpointConfig) options() []websocket.Option {
	if len(c.Headers) == 0 {
		return nil
	}
	return []websocket.Option{websocket.WithHTTPHeaders(c.Headers)}
}

func (c *WebsocketEndpointConfig) NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error) {
	se, err := c.Endpoint.NewStreamEndpoint(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build websocket inner endpoint: %w", err)
	}
	connect, err := websocket.NewStreamEndpoint(c.URL, se, c.options()...)
	if err != nil {
		return nil, err
	}
	return transport.FuncStreamEndpoint(connect), nil
}

func (c *WebsocketEndpointConfig) NewPacketEndpoint(ctx context.Context) (transport.PacketEndpoint, error) {
	se, err := c.Endpoint.NewStreamEndpoint(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build websocket inner endpoint: %w", err)
	}
	connect, err := websocket.NewPacketEndpoint(c.URL, se, c.options()...)
	if err != nil {
		return nil, err
	}
	return transport.FuncPacketEndpoint(connect), nil
}

type websocketOptions struct {
	headers http.Header
}

type WebsocketOption func(*websocketOptions)

// WithWebsocketHeaders sets default headers (e.g. an app User-Agent)
// on every parsed websocket config. The headers are cloned per config.
func WithWebsocketHeaders(h http.Header) WebsocketOption {
	return func(o *websocketOptions) { o.headers = h }
}

type websocketFields struct {
	URL      string
	Endpoint composer.Optional[composer.Node]
}

// NewWebsocketEndpointParser parses a websocket endpoint config.
func NewWebsocketEndpointParser(parseSE composer.ParseFunc[StreamEndpointConfig], opts ...WebsocketOption) composer.ParseFunc[*WebsocketEndpointConfig] {
	var options websocketOptions
	for _, o := range opts {
		o(&options)
	}
	return func(ctx context.Context, node composer.Node) (*WebsocketEndpointConfig, error) {
		var f websocketFields
		if err := node.Decode(&f); err != nil {
			return nil, err
		}
		u, err := url.Parse(f.URL)
		if err != nil {
			return nil, fmt.Errorf("url is invalid: %w", err)
		}
		port := u.Port()
		switch u.Scheme {
		case "https", "wss":
			u.Scheme = "wss"
			if port == "" {
				port = "443"
			}
		case "http", "ws":
			u.Scheme = "ws"
			if port == "" {
				port = "80"
			}
		default:
			return nil, fmt.Errorf("unsupported websocket scheme %q", u.Scheme)
		}
		if u.Hostname() == "" {
			return nil, fmt.Errorf("websocket url has no host")
		}

		endpointNode, ok := f.Endpoint.Get()
		if !ok {
			endpointNode, err = scalarNode(net.JoinHostPort(u.Hostname(), port))
			if err != nil {
				return nil, err
			}
		}
		inner, err := parseSE(ctx, endpointNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse websocket endpoint: %w", err)
		}
		return &WebsocketEndpointConfig{
			URL:      u.String(),
			Headers:  options.headers.Clone(),
			Endpoint: inner,
		}, nil
	}
}
```

Also add to `dialendpoint.go` or a new small `node.go` in netconfig:

```go
// scalarNode synthesizes a scalar composer.Node from a Go string, so a
// parser can delegate a derived value (e.g. a default endpoint address)
// through another parser.
func scalarNode(s string) (composer.Node, error) {
	return composer.ParseYAML([]byte(strconv.Quote(s)))
}
```

(`strconv.Quote` produces a double-quoted string, which is valid YAML.)
Note: `(http.Header)(nil).Clone()` returns nil — safe when no option is given.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./client/go/netconfig/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/netconfig && git add client/go/netconfig
git commit -m "feat(client/go): add netconfig websocket endpoint config with header option

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: netconfig shadowsocks

**Files:**
- Create: `client/go/netconfig/shadowsocks.go`
- Test: `client/go/netconfig/shadowsocks_test.go`

**Interfaces:**
- Consumes: `StreamEndpointConfig`, `PacketEndpointConfig`, `scalarNode`.
- Produces:

```go
type ShadowsocksStreamDialerConfig struct {
	Endpoint StreamEndpointConfig
	// key, saltGenerator unexported (validated at parse)
}
func (c *ShadowsocksStreamDialerConfig) NewStreamDialer(ctx) (transport.StreamDialer, error)
type ShadowsocksPacketListenerConfig struct { Endpoint PacketEndpointConfig /* + unexported key, saltGenerator */ }
func (c *ShadowsocksPacketListenerConfig) NewPacketListener(ctx) (transport.PacketListener, error)
type ShadowsocksPacketDialerConfig struct { Listener *ShadowsocksPacketListenerConfig }
func (c *ShadowsocksPacketDialerConfig) NewPacketDialer(ctx) (transport.PacketDialer, error)

func NewShadowsocksStreamDialerParser(parseSE composer.ParseFunc[StreamEndpointConfig]) composer.ParseFunc[*ShadowsocksStreamDialerConfig]
func NewShadowsocksPacketListenerParser(parsePE composer.ParseFunc[PacketEndpointConfig]) composer.ParseFunc[*ShadowsocksPacketListenerConfig]
func NewShadowsocksPacketDialerParser(parsePE composer.ParseFunc[PacketEndpointConfig]) composer.ParseFunc[*ShadowsocksPacketDialerConfig]
```

All three parsers accept: scalar `ss://` URL (SIP002 or legacy base64), mapping with `endpoint/cipher/secret/prefix?`, or legacy mapping with `server/server_port/method/password/prefix?`.

- [ ] **Step 1: Move the pure URL/prefix helpers verbatim**

Copy these functions **unchanged** from `client/go/outline/configregistry/config_shadowsocks.go` into `client/go/netconfig/shadowsocks.go` (do not delete the originals yet — deletion is Task 12):
- `parseShadowsocksURL` (lines 235–243), `cutLast` (248–254), `parseShadowsocksLegacyBase64URL` (256–296), `parseShadowsocksSIP002URL` (298–336), `parseStringPrefix` (223–233).
- Also copy the `ShadowsocksConfig` struct (lines 33–38) as the URL functions' return type, renamed to `ssURLResult` with field `Endpoint string` (the URL parsers always produce a string endpoint; change the field type from `configyaml.ConfigNode` to `string` and adjust nothing else — the two URL functions already only assign strings to it).

- [ ] **Step 2: Write the failing tests**

`client/go/netconfig/shadowsocks_test.go`:

```go
package netconfig

import (
	"context"
	"testing"

	"localhost/client/go/composer"
	"github.com/stretchr/testify/require"
)

func parseSEEcho() composer.ParseFunc[StreamEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (StreamEndpointConfig, error) {
		return &fakeSE{}, nil
	}
}

func TestShadowsocks_MappingConfig(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	cfg, err := parse(context.Background(), mustNode(t, `
$type: shadowsocks
endpoint: example.com:1234
cipher: chacha20-ietf-poly1305
secret: SECRET
prefix: "POST "
`))
	require.NoError(t, err)
	require.NotNil(t, cfg.Endpoint)
	sd, err := cfg.NewStreamDialer(context.Background())
	require.NoError(t, err)
	require.NotNil(t, sd)
}

func TestShadowsocks_LegacyMapping(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	_, err := parse(context.Background(), mustNode(t, `
server: example.com
server_port: 1234
method: chacha20-ietf-poly1305
password: SECRET
`))
	require.NoError(t, err)
}

func TestShadowsocks_SIP002URL(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	// base64("chacha20-ietf-poly1305:SECRET") = Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ
	_, err := parse(context.Background(),
		mustNode(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`))
	require.NoError(t, err)
}

func TestShadowsocks_Validation(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	for name, bad := range map[string]string{
		"missing cipher":   "endpoint: e:1\nsecret: s",
		"missing secret":   "endpoint: e:1\ncipher: aes-128-gcm",
		"missing endpoint": "cipher: aes-128-gcm\nsecret: s",
		"bad cipher":       "endpoint: e:1\ncipher: nope\nsecret: s",
		"bad prefix":       "endpoint: e:1\ncipher: aes-128-gcm\nsecret: s\nprefix: \"\\u0800\"",
	} {
		_, err := parse(context.Background(), mustNode(t, bad))
		require.Error(t, err, name)
	}
}
```

Then **port every test case** from `client/go/outline/configregistry/config_shadowsocks_test.go` (207 lines) that exercises URL parsing (SIP002 percent-encoded userinfo, SIP002 base64 variants, legacy base64 URLs, prefix query parameter, invalid URLs). Mechanical adaptation, worked example:

```go
// Legacy:
//   config, err := parseShadowsocksConfig("ss://...")
//   require.Equal(t, "example.com:1234", config.Endpoint)
// Ported:
//   res, err := parseShadowsocksNode(mustNode(t, `"ss://..."`))
//   require.Equal(t, "example.com:1234", res.endpointAddress)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./client/go/netconfig/... 2>&1 | tail -3`
Expected: FAIL (undefined symbols).

- [ ] **Step 4: Implement**

Add to `client/go/netconfig/shadowsocks.go` (below the moved helpers):

```go
// ssParams is the validated result of parsing any shadowsocks config form.
type ssParams struct {
	endpointNode    composer.Node // set for mapping form with an endpoint node
	endpointAddress string        // set for URL and legacy forms
	key             *shadowsocks.EncryptionKey
	saltGenerator   shadowsocks.SaltGenerator // nil when no prefix
}

// endpoint returns the endpoint as a Node, synthesizing one for
// address-only forms so it flows through the endpoint parser chain.
func (p *ssParams) endpoint() (composer.Node, error) {
	if p.endpointAddress != "" {
		return scalarNode(p.endpointAddress)
	}
	return p.endpointNode, nil
}

// ssFields decodes all shadowsocks mapping forms; presence of Endpoint
// vs Server selects the modern vs legacy schema.
type ssFields struct {
	Endpoint composer.Optional[composer.Node]
	Cipher   composer.Optional[string]
	Secret   composer.Optional[string]
	Prefix   composer.Optional[string]

	Server     composer.Optional[string]
	ServerPort composer.Optional[uint16]
	Method     composer.Optional[string]
	Password   composer.Optional[string]
}

func parseShadowsocksNode(node composer.Node) (*ssParams, error) {
	var cipher, secret, prefix, endpointAddress string
	var endpointNode composer.Node

	if node.Kind() == composer.KindScalar {
		var urlText string
		if err := node.Decode(&urlText); err != nil {
			return nil, err
		}
		u, err := url.Parse(urlText)
		if err != nil {
			return nil, fmt.Errorf("string config is not a valid URL: %w", err)
		}
		res, err := parseShadowsocksURL(*u)
		if err != nil {
			return nil, err
		}
		endpointAddress, cipher, secret, prefix = res.Endpoint, res.Cipher, res.Secret, res.Prefix
	} else {
		var f ssFields
		if err := node.Decode(&f); err != nil {
			return nil, err
		}
		if ep, ok := f.Endpoint.Get(); ok {
			endpointNode = ep
			cipher = f.Cipher.Or("")
			secret = f.Secret.Or("")
		} else if server, ok := f.Server.Get(); ok {
			port, ok := f.ServerPort.Get()
			if !ok {
				return nil, errors.New("legacy shadowsocks config missing server_port")
			}
			endpointAddress = net.JoinHostPort(server, strconv.FormatUint(uint64(port), 10))
			cipher = f.Method.Or("")
			secret = f.Password.Or("")
		} else {
			return nil, errors.New("shadowsocks config missing endpoint")
		}
		prefix = f.Prefix.Or("")
	}

	if cipher == "" {
		return nil, errors.New("cipher must not be empty")
	}
	if secret == "" {
		return nil, errors.New("secret must not be empty")
	}
	params := &ssParams{endpointNode: endpointNode, endpointAddress: endpointAddress}
	var err error
	params.key, err = shadowsocks.NewEncryptionKey(cipher, secret)
	if err != nil {
		return nil, fmt.Errorf("invalid cipher: %w", err)
	}
	if prefix != "" {
		prefixBytes, err := parseStringPrefix(prefix)
		if err != nil {
			return nil, fmt.Errorf("invalid prefix: %w", err)
		}
		params.saltGenerator = shadowsocks.NewPrefixSaltGenerator(prefixBytes)
	}
	return params, nil
}

type ShadowsocksStreamDialerConfig struct {
	Endpoint      StreamEndpointConfig
	key           *shadowsocks.EncryptionKey
	saltGenerator shadowsocks.SaltGenerator
}

func (c *ShadowsocksStreamDialerConfig) NewStreamDialer(ctx context.Context) (transport.StreamDialer, error) {
	se, err := c.Endpoint.NewStreamEndpoint(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build StreamEndpoint: %w", err)
	}
	sd, err := shadowsocks.NewStreamDialer(se, c.key)
	if err != nil {
		return nil, fmt.Errorf("failed to create StreamDialer: %w", err)
	}
	if c.saltGenerator != nil {
		sd.SaltGenerator = c.saltGenerator
	}
	return sd, nil
}

type ShadowsocksPacketListenerConfig struct {
	Endpoint      PacketEndpointConfig
	key           *shadowsocks.EncryptionKey
	saltGenerator shadowsocks.SaltGenerator
}

func (c *ShadowsocksPacketListenerConfig) NewPacketListener(ctx context.Context) (transport.PacketListener, error) {
	pe, err := c.Endpoint.NewPacketEndpoint(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build PacketEndpoint: %w", err)
	}
	pl, err := shadowsocks.NewPacketListener(pe, c.key)
	if err != nil {
		return nil, err
	}
	if c.saltGenerator != nil {
		pl.SetSaltGenerator(c.saltGenerator)
	}
	return pl, nil
}

type ShadowsocksPacketDialerConfig struct {
	Listener *ShadowsocksPacketListenerConfig
}

func (c *ShadowsocksPacketDialerConfig) NewPacketDialer(ctx context.Context) (transport.PacketDialer, error) {
	pl, err := c.Listener.NewPacketListener(ctx)
	if err != nil {
		return nil, err
	}
	return transport.PacketListenerDialer{Listener: pl}, nil
}

func NewShadowsocksStreamDialerParser(parseSE composer.ParseFunc[StreamEndpointConfig]) composer.ParseFunc[*ShadowsocksStreamDialerConfig] {
	return func(ctx context.Context, node composer.Node) (*ShadowsocksStreamDialerConfig, error) {
		params, err := parseShadowsocksNode(node)
		if err != nil {
			return nil, err
		}
		epNode, err := params.endpoint()
		if err != nil {
			return nil, err
		}
		se, err := parseSE(ctx, epNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse StreamEndpoint: %w", err)
		}
		return &ShadowsocksStreamDialerConfig{Endpoint: se, key: params.key, saltGenerator: params.saltGenerator}, nil
	}
}

func NewShadowsocksPacketListenerParser(parsePE composer.ParseFunc[PacketEndpointConfig]) composer.ParseFunc[*ShadowsocksPacketListenerConfig] {
	return func(ctx context.Context, node composer.Node) (*ShadowsocksPacketListenerConfig, error) {
		params, err := parseShadowsocksNode(node)
		if err != nil {
			return nil, err
		}
		epNode, err := params.endpoint()
		if err != nil {
			return nil, err
		}
		pe, err := parsePE(ctx, epNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse PacketEndpoint: %w", err)
		}
		return &ShadowsocksPacketListenerConfig{Endpoint: pe, key: params.key, saltGenerator: params.saltGenerator}, nil
	}
}

func NewShadowsocksPacketDialerParser(parsePE composer.ParseFunc[PacketEndpointConfig]) composer.ParseFunc[*ShadowsocksPacketDialerConfig] {
	listenerParser := NewShadowsocksPacketListenerParser(parsePE)
	return func(ctx context.Context, node composer.Node) (*ShadowsocksPacketDialerConfig, error) {
		pl, err := listenerParser(ctx, node)
		if err != nil {
			return nil, err
		}
		return &ShadowsocksPacketDialerConfig{Listener: pl}, nil
	}
}
```

Imports: `context`, `errors`, `fmt`, `net`, `net/url`, `strconv`, `localhost/client/go/composer`, `golang.getoutline.org/sdk/transport`, `golang.getoutline.org/sdk/transport/shadowsocks`, plus what the moved URL helpers need (`encoding/base64`, `strings`).

Behavior note (deliberate, matches legacy): the prefix salt generator applies to the stream dialer AND to a standalone `shadowsocks` packet listener; the legacy comment about UDP prefix compatibility concerns the *transport* form, handled in Task 8.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./client/go/netconfig/...`
Expected: PASS, including all ported URL cases.

- [ ] **Step 6: Commit**

```bash
gofmt -w client/go/netconfig && git add client/go/netconfig
git commit -m "feat(client/go): add netconfig shadowsocks configs and parsers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: connmeta side table

**Files:**
- Create: `client/go/outline/connmeta/connmeta.go`
- Test: `client/go/outline/connmeta/connmeta_test.go`

**Interfaces:**
- Produces:

```go
func WithTable(ctx context.Context) (context.Context, *Table)
func FromContext(ctx context.Context) *Table   // nil if absent
func (t *Table) Set(key any, value any)
func Get[V any](t *Table, key any) (V, bool)   // false if absent or wrong type
```

- [ ] **Step 1: Write the failing test**

`client/go/outline/connmeta/connmeta_test.go`:

```go
package connmeta

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type nodeA struct{ x int }
type info struct{ Hop string }

func TestTable_SetGet(t *testing.T) {
	ctx, table := WithTable(context.Background())
	require.Same(t, table, FromContext(ctx))

	n := &nodeA{}
	table.Set(n, info{Hop: "example.com:443"})
	got, ok := Get[info](table, n)
	require.True(t, ok)
	require.Equal(t, "example.com:443", got.Hop)

	// Identity, not equality: a different pointer misses.
	_, ok = Get[info](table, &nodeA{})
	require.False(t, ok)

	// Wrong type misses.
	_, ok = Get[string](table, n)
	require.False(t, ok)
}

func TestFromContext_Absent(t *testing.T) {
	require.Nil(t, FromContext(context.Background()))
	_, ok := Get[info](nil, &nodeA{})
	require.False(t, ok)
}

func TestTables_ArePerContext(t *testing.T) {
	_, t1 := WithTable(context.Background())
	_, t2 := WithTable(context.Background())
	n := &nodeA{}
	t1.Set(n, info{Hop: "a"})
	_, ok := Get[info](t2, n)
	require.False(t, ok)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./client/go/outline/connmeta/... 2>&1 | tail -3`
Expected: FAIL (package missing).

- [ ] **Step 3: Implement**

`client/go/outline/connmeta/connmeta.go`:

```go
// Package connmeta associates application metadata with parsed config
// objects, keyed by pointer identity — the go/types.Info pattern. A
// Table is created per parse call and carried in the context; parser
// wrappers record metadata as configs are composed, and the app reads
// it back after parsing.
package connmeta

import "context"

type contextKey struct{}

// Table maps config objects (by identity) to metadata values.
// It is not safe for concurrent use; a parse call is single-threaded.
type Table struct {
	m map[any]any
}

// WithTable returns a context carrying a new empty Table.
func WithTable(ctx context.Context) (context.Context, *Table) {
	t := &Table{m: make(map[any]any)}
	return context.WithValue(ctx, contextKey{}, t), t
}

// FromContext returns the Table carried by ctx, or nil.
func FromContext(ctx context.Context) *Table {
	t, _ := ctx.Value(contextKey{}).(*Table)
	return t
}

// Set records metadata for the given config object.
func (t *Table) Set(key any, value any) {
	t.m[key] = value
}

// Get returns the metadata of type V recorded for key.
func Get[V any](t *Table, key any) (V, bool) {
	var zero V
	if t == nil {
		return zero, false
	}
	v, ok := t.m[key].(V)
	if !ok {
		return zero, false
	}
	return v, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./client/go/outline/connmeta/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/outline/connmeta && git add client/go/outline/connmeta
git commit -m "feat(client/go): add connmeta side table for parsed-config metadata

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: composer registry with metadata wrappers (dialers, endpoints, listeners)

**Files:**
- Create: `client/go/outline/configregistry/composer_registry.go`
- Test: `client/go/outline/configregistry/composer_registry_test.go`

**Interfaces:**
- Consumes: netconfig (Tasks 1–4), connmeta (Task 5), existing `ConnectionProviderInfo`/`ConnType` from `types.go`.
- Produces (for Tasks 7–10):

```go
// registryTables bundles the category parsers so iptable/transport tasks can register into them.
type registryTables struct {
	streamDialers   *composer.TypeParser[netconfig.StreamDialerConfig]
	packetDialers   *composer.TypeParser[netconfig.PacketDialerConfig]
	streamEndpoints *composer.TypeParser[netconfig.StreamEndpointConfig]
	packetEndpoints *composer.TypeParser[netconfig.PacketEndpointConfig]
	packetListeners *composer.TypeParser[netconfig.PacketListenerConfig]
}
func newRegistryTables(directSD transport.StreamDialer, directPD transport.PacketDialer) *registryTables
func setInfo(ctx context.Context, cfg any, info any) error          // errors if no table in ctx
func requireInfo(ctx context.Context, cfg any) (ConnectionProviderInfo, error)
```

Wiring rules (all mirroring `registry.go` legacy behavior — read it side by side):
- **streamDialers fallback**: absent → the shared `*DirectStreamDialerConfig` (info `{ConnTypeDirect, ""}`); scalar → shadowsocks URL via `netconfig.NewShadowsocksStreamDialerParser` with the shadowsocks info function; otherwise "parser not specified".
- **packetDialers fallback**: same shape using the packet variants.
- **packetListeners fallback**: absent → shared `*DirectPacketListenerConfig` (`&transport.UDPListener{}`); otherwise "parser not specified".
- **streamEndpoints / packetEndpoints fallback**: dial-endpoint parser (handles scalar and `{address, dialer}` mapping). Endpoint info: copy the child dialer's info; if child is direct, `FirstHop = cfg.Address`; **and set the app policy flag**: `cfg.ResolveAddressFirst = childIsDirect && (runtime.GOOS == "linux" || runtime.GOOS == "windows") && !testing.Testing()`.
- **Registrations with info functions**:
  - `block` (stream + packet dialers): info `{ConnType: ConnTypeBlocked}`.
  - `direct` (stream + packet dialers, packet listeners): returns the shared direct config; info `{ConnTypeDirect, ""}`.
  - `shadowsocks` (stream dialers): info `{ConnTypeTunneled, FirstHop: requireInfo(cfg.Endpoint).FirstHop}`. Same for packet dialers (via `cfg.Listener.Endpoint`) and packet listeners (via `cfg.Endpoint`).
  - `dial` (stream + packet endpoints): registered explicitly with the same parser as the fallback.
  - `websocket` (stream + packet endpoints): built with `netconfig.WithWebsocketHeaders(http.Header{"User-Agent": {useragent.GetOutlineUserAgent()}})`; info: copy of inner endpoint's info (legacy behavior).
- `first-supported` is built into composer's TypeParser — no registration, no wrapper.

- [ ] **Step 1: Write the failing test**

`client/go/outline/configregistry/composer_registry_test.go`:

```go
package configregistry

import (
	"context"
	"testing"

	"localhost/client/go/composer"
	"localhost/client/go/outline/connmeta"
	"localhost/client/go/netconfig"
	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
)

func parseSD(t *testing.T, text string) (netconfig.StreamDialerConfig, *connmeta.Table) {
	t.Helper()
	tables := newRegistryTables(&transport.TCPDialer{}, &transport.UDPDialer{})
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	ctx, table := connmeta.WithTable(context.Background())
	cfg, err := tables.streamDialers.Parse(ctx, node)
	require.NoError(t, err)
	return cfg, table
}

func TestRegistry_DirectFallbackInfo(t *testing.T) {
	cfg, table := parseSD(t, "")
	info, ok := connmeta.Get[ConnectionProviderInfo](table, cfg)
	require.True(t, ok)
	require.Equal(t, ConnectionProviderInfo{ConnTypeDirect, ""}, info)
}

func TestRegistry_ShadowsocksInfo(t *testing.T) {
	cfg, table := parseSD(t, `
$type: shadowsocks
endpoint: example.com:1234
cipher: chacha20-ietf-poly1305
secret: SECRET
`)
	info, ok := connmeta.Get[ConnectionProviderInfo](table, cfg)
	require.True(t, ok)
	require.Equal(t, ConnTypeTunneled, info.ConnType)
	require.Equal(t, "example.com:1234", info.FirstHop)
}

func TestRegistry_WebsocketOverShadowsocks(t *testing.T) {
	cfg, table := parseSD(t, `
$type: shadowsocks
cipher: chacha20-ietf-poly1305
secret: SECRET
endpoint:
  $type: websocket
  url: wss://cdn.example.com/tcp
`)
	info, ok := connmeta.Get[ConnectionProviderInfo](table, cfg)
	require.True(t, ok)
	require.Equal(t, ConnTypeTunneled, info.ConnType)
	// Websocket copies its inner (direct dial) endpoint's info: the
	// first hop is the CDN address.
	require.Equal(t, "cdn.example.com:443", info.FirstHop)
	// The websocket config carries the Outline User-Agent.
	ws := findWebsocket(cfg)
	require.NotNil(t, ws)
	require.NotEmpty(t, ws.Headers.Get("User-Agent"))
}

// findWebsocket digs the websocket config out of a shadowsocks dialer config.
func findWebsocket(cfg netconfig.StreamDialerConfig) *netconfig.WebsocketEndpointConfig {
	ss, ok := cfg.(*netconfig.ShadowsocksStreamDialerConfig)
	if !ok {
		return nil
	}
	ws, _ := ss.Endpoint.(*netconfig.WebsocketEndpointConfig)
	return ws
}

func TestRegistry_FirstSupportedPassthrough(t *testing.T) {
	cfg, table := parseSD(t, `
$type: first-supported
options:
  - $type: warp-drive
  - $type: block
`)
	info, ok := connmeta.Get[ConnectionProviderInfo](table, cfg)
	require.True(t, ok)
	require.Equal(t, ConnTypeBlocked, info.ConnType)
}

func TestRegistry_SSURLStringFallback(t *testing.T) {
	cfg, table := parseSD(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`)
	info, ok := connmeta.Get[ConnectionProviderInfo](table, cfg)
	require.True(t, ok)
	require.Equal(t, ConnTypeTunneled, info.ConnType)
	require.Equal(t, "example.com:1234", info.FirstHop)
	_ = cfg
}

func TestRegistry_MissingTableErrors(t *testing.T) {
	tables := newRegistryTables(&transport.TCPDialer{}, &transport.UDPDialer{})
	node, err := composer.ParseYAML([]byte("$type: block"))
	require.NoError(t, err)
	_, err = tables.streamDialers.Parse(context.Background(), node) // no table in ctx
	require.Error(t, err)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./client/go/outline/configregistry/ -run TestRegistry 2>&1 | tail -3`
Expected: FAIL (undefined: newRegistryTables).

- [ ] **Step 3: Implement**

`client/go/outline/configregistry/composer_registry.go`:

```go
package configregistry

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"testing"

	"localhost/client/go/composer"
	"localhost/client/go/netconfig"
	"localhost/client/go/outline/connmeta"
	"localhost/client/go/outline/useragent"
	"golang.getoutline.org/sdk/transport"
)

// setInfo records metadata for cfg in the context's connmeta table.
// A missing table is a wiring bug: parsing must be started via
// connmeta.WithTable.
func setInfo(ctx context.Context, cfg any, info any) error {
	t := connmeta.FromContext(ctx)
	if t == nil {
		return errors.New("internal error: no connmeta table in context")
	}
	t.Set(cfg, info)
	return nil
}

// requireInfo reads a child config's ConnectionProviderInfo; children
// are always parsed (and recorded) before their parent's info function
// runs.
func requireInfo(ctx context.Context, cfg any) (ConnectionProviderInfo, error) {
	info, ok := connmeta.Get[ConnectionProviderInfo](connmeta.FromContext(ctx), cfg)
	if !ok {
		return ConnectionProviderInfo{}, fmt.Errorf("internal error: no connection info for %T", cfg)
	}
	return info, nil
}

// withInfo decorates a parser so that every parsed config gets its
// ConnectionProviderInfo computed and recorded.
func withInfo[Cfg any](parse composer.ParseFunc[Cfg], info func(ctx context.Context, cfg Cfg) (ConnectionProviderInfo, error)) composer.ParseFunc[Cfg] {
	return func(ctx context.Context, node composer.Node) (Cfg, error) {
		var zero Cfg
		cfg, err := parse(ctx, node)
		if err != nil {
			return zero, err
		}
		i, err := info(ctx, cfg)
		if err != nil {
			return zero, err
		}
		if err := setInfo(ctx, cfg, i); err != nil {
			return zero, err
		}
		return cfg, nil
	}
}

type registryTables struct {
	streamDialers   *composer.TypeParser[netconfig.StreamDialerConfig]
	packetDialers   *composer.TypeParser[netconfig.PacketDialerConfig]
	streamEndpoints *composer.TypeParser[netconfig.StreamEndpointConfig]
	packetEndpoints *composer.TypeParser[netconfig.PacketEndpointConfig]
	packetListeners *composer.TypeParser[netconfig.PacketListenerConfig]
}

// resolveFirstOnThisPlatform reports whether direct dial endpoints
// should resolve their address at build time. On Linux and Windows we
// cannot protect the system DNS resolution (FW_MARK / interface
// binding), so we resolve upfront. Skipped in tests.
func resolveFirstOnThisPlatform() bool {
	return (runtime.GOOS == "linux" || runtime.GOOS == "windows") && !testing.Testing()
}

func newRegistryTables(directSD transport.StreamDialer, directPD transport.PacketDialer) *registryTables {
	t := &registryTables{}

	directSDCfg := netconfig.NewDirectStreamDialerConfig(directSD)
	directPDCfg := netconfig.NewDirectPacketDialerConfig(directPD)
	directPLCfg := netconfig.NewDirectPacketListenerConfig(&transport.UDPListener{})
	directInfo := ConnectionProviderInfo{ConnTypeDirect, ""}

	// Info functions shared between registration and fallbacks.
	ssStreamInfo := func(ctx context.Context, cfg *netconfig.ShadowsocksStreamDialerConfig) (ConnectionProviderInfo, error) {
		epInfo, err := requireInfo(ctx, cfg.Endpoint)
		if err != nil {
			return ConnectionProviderInfo{}, err
		}
		return ConnectionProviderInfo{ConnTypeTunneled, epInfo.FirstHop}, nil
	}
	ssListenerInfo := func(ctx context.Context, cfg *netconfig.ShadowsocksPacketListenerConfig) (ConnectionProviderInfo, error) {
		epInfo, err := requireInfo(ctx, cfg.Endpoint)
		if err != nil {
			return ConnectionProviderInfo{}, err
		}
		return ConnectionProviderInfo{ConnTypeTunneled, epInfo.FirstHop}, nil
	}

	// Stream dialers.
	t.streamDialers = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (netconfig.StreamDialerConfig, error) {
		switch node.Kind() {
		case composer.KindAbsent:
			if err := setInfo(ctx, directSDCfg, directInfo); err != nil {
				return nil, err
			}
			return directSDCfg, nil
		case composer.KindScalar:
			parse := withInfo(netconfig.NewShadowsocksStreamDialerParser(t.streamEndpoints.Parse), ssStreamInfo)
			return asStreamDialer(parse)(ctx, node)
		default:
			return nil, errors.New("parser not specified")
		}
	})

	// Packet dialers.
	t.packetDialers = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (netconfig.PacketDialerConfig, error) {
		switch node.Kind() {
		case composer.KindAbsent:
			if err := setInfo(ctx, directPDCfg, directInfo); err != nil {
				return nil, err
			}
			return directPDCfg, nil
		case composer.KindScalar:
			parse := withInfo(netconfig.NewShadowsocksPacketDialerParser(t.packetEndpoints.Parse),
				func(ctx context.Context, cfg *netconfig.ShadowsocksPacketDialerConfig) (ConnectionProviderInfo, error) {
					return ssListenerInfo(ctx, cfg.Listener)
				})
			return asPacketDialer(parse)(ctx, node)
		default:
			return nil, errors.New("parser not specified")
		}
	})

	// Packet listeners.
	t.packetListeners = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (netconfig.PacketListenerConfig, error) {
		if node.IsAbsent() {
			if err := setInfo(ctx, directPLCfg, directInfo); err != nil {
				return nil, err
			}
			return directPLCfg, nil
		}
		return nil, errors.New("parser not specified")
	})

	// Endpoints: fallback and "dial" both use the dial-endpoint parser.
	streamDialEndpoint := withInfo(netconfig.NewStreamDialEndpointParser(t.streamDialers.Parse),
		func(ctx context.Context, cfg *netconfig.StreamDialEndpointConfig) (ConnectionProviderInfo, error) {
			dialerInfo, err := requireInfo(ctx, cfg.Dialer)
			if err != nil {
				return ConnectionProviderInfo{}, err
			}
			info := dialerInfo
			if dialerInfo.ConnType == ConnTypeDirect {
				info.FirstHop = cfg.Address
				cfg.ResolveAddressFirst = resolveFirstOnThisPlatform()
			}
			return info, nil
		})
	t.streamEndpoints = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (netconfig.StreamEndpointConfig, error) {
		return asStreamEndpoint(streamDialEndpoint)(ctx, node)
	})

	packetDialEndpoint := withInfo(netconfig.NewPacketDialEndpointParser(t.packetDialers.Parse),
		func(ctx context.Context, cfg *netconfig.PacketDialEndpointConfig) (ConnectionProviderInfo, error) {
			dialerInfo, err := requireInfo(ctx, cfg.Dialer)
			if err != nil {
				return ConnectionProviderInfo{}, err
			}
			info := dialerInfo
			if dialerInfo.ConnType == ConnTypeDirect {
				info.FirstHop = cfg.Address
				cfg.ResolveAddressFirst = resolveFirstOnThisPlatform()
			}
			return info, nil
		})
	t.packetEndpoints = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (netconfig.PacketEndpointConfig, error) {
		return asPacketEndpoint(packetDialEndpoint)(ctx, node)
	})

	// Websocket endpoints, with the Outline User-Agent as app policy.
	wsHeaders := http.Header{"User-Agent": []string{useragent.GetOutlineUserAgent()}}
	wsParser := withInfo(
		netconfig.NewWebsocketEndpointParser(t.streamEndpoints.Parse, netconfig.WithWebsocketHeaders(wsHeaders)),
		func(ctx context.Context, cfg *netconfig.WebsocketEndpointConfig) (ConnectionProviderInfo, error) {
			return requireInfo(ctx, cfg.Endpoint)
		})

	// Registrations.
	t.streamEndpoints.RegisterSubParser("dial", asStreamEndpoint(streamDialEndpoint))
	t.streamEndpoints.RegisterSubParser("websocket", asStreamEndpoint(wsParser))
	t.packetEndpoints.RegisterSubParser("dial", asPacketEndpoint(packetDialEndpoint))
	t.packetEndpoints.RegisterSubParser("websocket", asPacketEndpoint(wsParser))

	blockParse := withInfo(
		func(ctx context.Context, node composer.Node) (*netconfig.BlockConfig, error) {
			return netconfig.ParseBlock(ctx, node)
		},
		func(ctx context.Context, cfg *netconfig.BlockConfig) (ConnectionProviderInfo, error) {
			return ConnectionProviderInfo{ConnType: ConnTypeBlocked}, nil
		})
	t.streamDialers.RegisterSubParser("block", asStreamDialer(blockParse))
	t.packetDialers.RegisterSubParser("block", asPacketDialer(blockParse))

	t.streamDialers.RegisterSubParser("direct", func(ctx context.Context, node composer.Node) (netconfig.StreamDialerConfig, error) {
		if err := setInfo(ctx, directSDCfg, directInfo); err != nil {
			return nil, err
		}
		return directSDCfg, nil
	})
	t.packetDialers.RegisterSubParser("direct", func(ctx context.Context, node composer.Node) (netconfig.PacketDialerConfig, error) {
		if err := setInfo(ctx, directPDCfg, directInfo); err != nil {
			return nil, err
		}
		return directPDCfg, nil
	})
	t.packetListeners.RegisterSubParser("direct", func(ctx context.Context, node composer.Node) (netconfig.PacketListenerConfig, error) {
		if err := setInfo(ctx, directPLCfg, directInfo); err != nil {
			return nil, err
		}
		return directPLCfg, nil
	})

	t.streamDialers.RegisterSubParser("shadowsocks",
		asStreamDialer(withInfo(netconfig.NewShadowsocksStreamDialerParser(t.streamEndpoints.Parse), ssStreamInfo)))
	t.packetDialers.RegisterSubParser("shadowsocks",
		asPacketDialer(withInfo(netconfig.NewShadowsocksPacketDialerParser(t.packetEndpoints.Parse),
			func(ctx context.Context, cfg *netconfig.ShadowsocksPacketDialerConfig) (ConnectionProviderInfo, error) {
				return ssListenerInfo(ctx, cfg.Listener)
			})))
	t.packetListeners.RegisterSubParser("shadowsocks",
		asPacketListener(withInfo(netconfig.NewShadowsocksPacketListenerParser(t.packetEndpoints.Parse), ssListenerInfo)))

	return t
}

// Interface-conversion adapters (Go cannot convert ParseFunc[*X] to
// ParseFunc[Iface] implicitly).
func asStreamDialer[Cfg netconfig.StreamDialerConfig](p composer.ParseFunc[Cfg]) composer.ParseFunc[netconfig.StreamDialerConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.StreamDialerConfig, error) {
		cfg, err := p(ctx, node)
		if err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func asPacketDialer[Cfg netconfig.PacketDialerConfig](p composer.ParseFunc[Cfg]) composer.ParseFunc[netconfig.PacketDialerConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.PacketDialerConfig, error) {
		cfg, err := p(ctx, node)
		if err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func asStreamEndpoint[Cfg netconfig.StreamEndpointConfig](p composer.ParseFunc[Cfg]) composer.ParseFunc[netconfig.StreamEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.StreamEndpointConfig, error) {
		cfg, err := p(ctx, node)
		if err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func asPacketEndpoint[Cfg netconfig.PacketEndpointConfig](p composer.ParseFunc[Cfg]) composer.ParseFunc[netconfig.PacketEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.PacketEndpointConfig, error) {
		cfg, err := p(ctx, node)
		if err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func asPacketListener[Cfg netconfig.PacketListenerConfig](p composer.ParseFunc[Cfg]) composer.ParseFunc[netconfig.PacketListenerConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.PacketListenerConfig, error) {
		cfg, err := p(ctx, node)
		if err != nil {
			return nil, err
		}
		return cfg, nil
	}
}
```

Note the forward references (`t.streamEndpoints.Parse` inside the streamDialers fallback closure) mirror the legacy pattern — the closures run at parse time, after all fields are assigned. `import "testing"` in non-test code mirrors legacy `config_dial_endpoint.go`; it is contained to `resolveFirstOnThisPlatform`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/outline/configregistry/ -run TestRegistry -v 2>&1 | tail -12`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/outline/configregistry && git add client/go/outline/configregistry
git commit -m "feat(client/go): add composer-based registry with connmeta wrappers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: iptable config (app-side)

**Files:**
- Create: `client/go/outline/configregistry/iptable_config.go`
- Modify: `client/go/outline/configregistry/composer_registry.go` (register `iptable`)
- Test: `client/go/outline/configregistry/iptable_config_test.go`

**Interfaces:**
- Produces: `IPTableStreamDialerConfig` implementing `netconfig.StreamDialerConfig`, registered as `iptable` on `t.streamDialers`.

```go
type IPTableStreamDialerConfig struct {
	Entries  []IPTableEntryConfig // prefix -> dialer config
	Fallback netconfig.StreamDialerConfig // nil if absent
}
type IPTableEntryConfig struct {
	Prefixes []netip.Prefix
	Dialer   netconfig.StreamDialerConfig
}
```

Port from legacy `config_iptable.go`: wire fields `table` (list of `{ips, dialer}`) and `fallback`; each `ips` entry is an IP or CIDR (bare IPs become /32 or /128); empty table is an error; entry without dialer is an error. `New` builds `iptable.NewIPTable[transport.StreamDialer]` + `iptable.NewStreamDialer`. The ConnType aggregation (all-blocked → Blocked; all-tunneled → Tunneled; all-direct → Direct; else Partial; blocked entries excluded from the tunneled/direct votes; FirstHop empty) moves to the registration's info function, reading each entry's child info from connmeta.

- [ ] **Step 1: Write the failing tests**

Port ALL test cases from `client/go/outline/configregistry/config_iptable_test.go` (333 lines) to the new API. Worked example of the adaptation:

```go
// Legacy:
//   parser builds Dialer[transport.StreamConn], asserts d.ConnType == ConnTypePartial
// Ported:
//   cfg, table := parseSD(t, yamlText)   // helper from composer_registry_test.go
//   info, ok := connmeta.Get[ConnectionProviderInfo](table, cfg)
//   require.True(t, ok)
//   require.Equal(t, ConnTypePartial, info.ConnType)
```

Port every case: empty table error, missing dialer error, bad IP error, bare-IP-as-prefix, aggregation cases (all tunneled / all direct / mixed / with blocked entries / fallback affecting aggregation), and dial dispatch (build the dialer with fake sub-dialers and assert an in-table IP routes to the entry dialer, out-of-table to fallback). For dial dispatch, inject fakes by registering a test-only sub-parser is NOT needed: build `IPTableStreamDialerConfig` directly in the test with fake `netconfig.StreamDialerConfig` values and call `NewStreamDialer`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/outline/configregistry/ -run TestIPTable 2>&1 | tail -3`
Expected: FAIL (undefined symbols).

- [ ] **Step 3: Implement**

`client/go/outline/configregistry/iptable_config.go`:

```go
package configregistry

import (
	"context"
	"errors"
	"fmt"
	"net/netip"

	"localhost/client/go/composer"
	"localhost/client/go/netconfig"
	"localhost/client/go/outline/iptable"
	"golang.getoutline.org/sdk/transport"
)

type IPTableEntryConfig struct {
	Prefixes []netip.Prefix
	Dialer   netconfig.StreamDialerConfig
}

// IPTableStreamDialerConfig routes by destination IP prefix.
type IPTableStreamDialerConfig struct {
	Entries  []IPTableEntryConfig
	Fallback netconfig.StreamDialerConfig // nil: no fallback
}

func (c *IPTableStreamDialerConfig) NewStreamDialer(ctx context.Context) (transport.StreamDialer, error) {
	table := iptable.NewIPTable[transport.StreamDialer]()
	for _, entry := range c.Entries {
		dialer, err := entry.Dialer.NewStreamDialer(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to build iptable entry dialer: %w", err)
		}
		for _, prefix := range entry.Prefixes {
			table.AddPrefix(prefix, dialer)
		}
	}
	var fallback transport.StreamDialer
	if c.Fallback != nil {
		var err error
		fallback, err = c.Fallback.NewStreamDialer(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to build iptable fallback dialer: %w", err)
		}
	}
	return iptable.NewStreamDialer(table, fallback)
}

type ipTableEntryFields struct {
	IPs    []string
	Dialer composer.Node
}

type ipTableFields struct {
	Table    []ipTableEntryFields
	Fallback composer.Optional[composer.Node]
}

func newIPTableParser(parseSD composer.ParseFunc[netconfig.StreamDialerConfig]) composer.ParseFunc[*IPTableStreamDialerConfig] {
	return func(ctx context.Context, node composer.Node) (*IPTableStreamDialerConfig, error) {
		var f ipTableFields
		if err := node.Decode(&f); err != nil {
			return nil, fmt.Errorf("failed to decode iptable config: %w", err)
		}
		if len(f.Table) == 0 {
			return nil, errors.New("iptable config 'table' must not be empty")
		}
		cfg := &IPTableStreamDialerConfig{}
		for i, entry := range f.Table {
			if entry.Dialer.IsAbsent() {
				return nil, fmt.Errorf("iptable entry %d has no dialer specified", i)
			}
			dialer, err := parseSD(ctx, entry.Dialer)
			if err != nil {
				return nil, fmt.Errorf("failed to parse dialer for table entry %d: %w", i, err)
			}
			parsed := IPTableEntryConfig{Dialer: dialer}
			for _, ip := range entry.IPs {
				prefix, err := netip.ParsePrefix(ip)
				if err != nil {
					addr, errAddr := netip.ParseAddr(ip)
					if errAddr != nil {
						return nil, fmt.Errorf("iptable entry %d IP %q is not a valid IP address or CIDR prefix", i, ip)
					}
					prefix = netip.PrefixFrom(addr, addr.BitLen())
				}
				parsed.Prefixes = append(parsed.Prefixes, prefix)
			}
			cfg.Entries = append(cfg.Entries, parsed)
		}
		if fbNode, ok := f.Fallback.Get(); ok {
			fallback, err := parseSD(ctx, fbNode)
			if err != nil {
				return nil, fmt.Errorf("failed to parse fallback dialer: %w", err)
			}
			cfg.Fallback = fallback
		}
		return cfg, nil
	}
}

// ipTableInfo aggregates the entry dialers' connection types.
func ipTableInfo(ctx context.Context, cfg *IPTableStreamDialerConfig) (ConnectionProviderInfo, error) {
	allTunneled, allDirect, allBlocked := true, true, true
	consider := func(info ConnectionProviderInfo) {
		if info.ConnType == ConnTypeBlocked {
			return
		}
		allBlocked = false
		if info.ConnType != ConnTypeTunneled {
			allTunneled = false
		}
		if info.ConnType != ConnTypeDirect {
			allDirect = false
		}
	}
	for _, entry := range cfg.Entries {
		info, err := requireInfo(ctx, entry.Dialer)
		if err != nil {
			return ConnectionProviderInfo{}, err
		}
		consider(info)
	}
	if cfg.Fallback != nil {
		info, err := requireInfo(ctx, cfg.Fallback)
		if err != nil {
			return ConnectionProviderInfo{}, err
		}
		consider(info)
	}
	switch {
	case allBlocked:
		return ConnectionProviderInfo{ConnType: ConnTypeBlocked}, nil
	case allTunneled:
		return ConnectionProviderInfo{ConnType: ConnTypeTunneled}, nil
	case allDirect:
		return ConnectionProviderInfo{ConnType: ConnTypeDirect}, nil
	default:
		return ConnectionProviderInfo{ConnType: ConnTypePartial}, nil
	}
}
```

In `newRegistryTables` (Task 6 file), add after the shadowsocks registrations:

```go
	t.streamDialers.RegisterSubParser("iptable",
		asStreamDialer(withInfo(newIPTableParser(t.streamDialers.Parse), ipTableInfo)))
```

Note: legacy had an unreachable "allConnDirect && allConnTunnelled cannot both be true" error path; it is dropped (the switch order makes it moot — with a non-empty table and no non-blocked entries, `allBlocked` wins first).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/outline/configregistry/...`
Expected: PASS (old iptable tests still pass too — legacy files are untouched until Task 12).

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/outline/configregistry && git add client/go/outline/configregistry
git commit -m "feat(client/go): port iptable dialer config to composer registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: transport-pair configs and relocated DNS wrap

**Files:**
- Create: `client/go/outline/configregistry/transport_configs.go`, `client/go/outline/configregistry/outline_dns.go`
- Modify: `client/go/outline/configregistry/composer_registry.go`
- Test: `client/go/outline/configregistry/transport_configs_test.go`

**Interfaces:**
- Produces (consumed by Tasks 9–11):

```go
type TransportPairInfo struct { Stream, Packet ConnectionProviderInfo }
type TransportPairParts struct {
	StreamDialer   transport.StreamDialer
	PacketListener transport.PacketListener
}
type TransportPairConfig interface {
	NewTransportPair(ctx context.Context) (*TransportPairParts, error)
}
func NewComposerTransportParser(directSD transport.StreamDialer, directPD transport.PacketDialer) *composer.TypeParser[TransportPairConfig]
// outline_dns.go — the DNS policy, applied by the app AFTER build:
func NewOutlineDNSTransport(sd transport.StreamDialer, pl transport.PacketListener) (transport.StreamDialer, packetrelay.PacketRelay, func(), error)
```

Concrete transport configs (all in `transport_configs.go`):
- `TCPUDPTransportConfig{TCP netconfig.StreamDialerConfig; UDP netconfig.PacketListenerConfig}` — wire fields `tcp`, `udp`, both optional (absent → registry fallbacks: direct). Info: `TransportPairInfo{Stream: info(TCP), Packet: info(UDP)}`.
- `BasicAccessTransportConfig{}` — `$type: basic-access`, no fields (legacy TODO preserved). `New`: `tlsfrag.NewFixedLenStreamDialer(&transport.TCPDialer{}, randomSplitLength())` + `&transport.UDPListener{}`. The random split-length pick happens in `New`, not parse. Move `MIN_SPLIT`/`MAX_SPLIT`/`randomSplitLength` from `config_proxyless.go` verbatim (rename to `minSplit`/`maxSplit` — they become unexported). Info: both sides `{ConnTypeDirect, ""}`.
- `ShadowsocksTransportConfig{StreamDialer *netconfig.ShadowsocksStreamDialerConfig; PacketListener *netconfig.ShadowsocksPacketListenerConfig}` — the transports fallback (scalar `ss://` URL or legacy mapping without `$type`). Parses the same node twice, via the stream-dialer and packet-listener shadowsocks parsers (matching legacy `parseShadowsocksTransport`; the TCP-only prefix nuance is preserved because the legacy code applied the salt generator to both sides too — verify against legacy lines 94–99 and keep identical behavior). Info: `TransportPairInfo{Stream: ssInfo(sd), Packet: ssInfo(pl)}`.

`NewComposerTransportParser` builds `newRegistryTables(...)`, creates the transports TypeParser with the shadowsocks fallback, registers `tcpudp` + `basic-access` with `withTransportInfo` (a `withInfo` twin whose info type is `TransportPairInfo`).

`outline_dns.go`: move the body of `wrapTransportPairWithOutlineDNS` from `outline_dns_intercept.go` into `NewOutlineDNSTransport` with the new plain-types signature — same resolver list, link-local address, relay construction, truncate/forward switching, and `connectivity.CheckUDPConnectivity` call. Returns `(wrappedSD, relayMain, onNetworkChanged, error)`. Leave `outline_dns_intercept.go` untouched (legacy parsers still call it until Task 12; Task 12 deletes it).

- [ ] **Step 1: Write the failing tests**

`client/go/outline/configregistry/transport_configs_test.go`:

```go
package configregistry

import (
	"context"
	"testing"

	"localhost/client/go/composer"
	"localhost/client/go/outline/connmeta"
	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
)

func parseTransport(t *testing.T, text string) (TransportPairConfig, *connmeta.Table) {
	t.Helper()
	parser := NewComposerTransportParser(&transport.TCPDialer{}, &transport.UDPDialer{})
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	ctx, table := connmeta.WithTable(context.Background())
	cfg, err := parser.Parse(ctx, node)
	require.NoError(t, err)
	return cfg, table
}

func requirePairInfo(t *testing.T, table *connmeta.Table, cfg TransportPairConfig) TransportPairInfo {
	t.Helper()
	info, ok := connmeta.Get[TransportPairInfo](table, cfg)
	require.True(t, ok, "transport pair info missing")
	return info
}

func TestTransport_LegacySSURL(t *testing.T) {
	cfg, table := parseTransport(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`)
	info := requirePairInfo(t, table, cfg)
	require.Equal(t, ConnTypeTunneled, info.Stream.ConnType)
	require.Equal(t, "example.com:1234", info.Stream.FirstHop)
	require.Equal(t, ConnTypeTunneled, info.Packet.ConnType)

	parts, err := cfg.NewTransportPair(context.Background())
	require.NoError(t, err)
	require.NotNil(t, parts.StreamDialer)
	require.NotNil(t, parts.PacketListener)
}

func TestTransport_LegacyMappingNoType(t *testing.T) {
	cfg, table := parseTransport(t, `
server: example.com
server_port: 1234
method: chacha20-ietf-poly1305
password: SECRET
`)
	info := requirePairInfo(t, table, cfg)
	require.Equal(t, "example.com:1234", info.Stream.FirstHop)
	_ = cfg
}

func TestTransport_TCPUDP(t *testing.T) {
	cfg, table := parseTransport(t, `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint: example.com:1234
  cipher: chacha20-ietf-poly1305
  secret: SECRET
udp:
  $type: shadowsocks
  endpoint: example.com:5678
  cipher: chacha20-ietf-poly1305
  secret: SECRET
`)
	info := requirePairInfo(t, table, cfg)
	require.Equal(t, "example.com:1234", info.Stream.FirstHop)
	require.Equal(t, "example.com:5678", info.Packet.FirstHop)
}

func TestTransport_TCPUDP_DefaultsToDirect(t *testing.T) {
	cfg, table := parseTransport(t, "$type: tcpudp")
	info := requirePairInfo(t, table, cfg)
	require.Equal(t, ConnTypeDirect, info.Stream.ConnType)
	require.Equal(t, ConnTypeDirect, info.Packet.ConnType)
	_ = cfg
}

func TestTransport_BasicAccess(t *testing.T) {
	cfg, table := parseTransport(t, "$type: basic-access")
	info := requirePairInfo(t, table, cfg)
	require.Equal(t, ConnTypeDirect, info.Stream.ConnType)
	parts, err := cfg.NewTransportPair(context.Background())
	require.NoError(t, err)
	require.NotNil(t, parts.StreamDialer)
}

func TestTransport_FirstSupported(t *testing.T) {
	cfg, table := parseTransport(t, `
$type: first-supported
options:
  - $type: warp-drive
  - $type: tcpudp
`)
	info := requirePairInfo(t, table, cfg)
	require.Equal(t, ConnTypeDirect, info.Stream.ConnType)
	_ = cfg
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./client/go/outline/configregistry/ -run TestTransport 2>&1 | tail -3`
Expected: FAIL (undefined: NewComposerTransportParser).

- [ ] **Step 3: Implement**

`client/go/outline/configregistry/transport_configs.go`:

```go
package configregistry

import (
	"context"
	"errors"
	"fmt"
	"math/rand"

	"localhost/client/go/composer"
	"localhost/client/go/netconfig"
	"golang.getoutline.org/sdk/transport"
	"golang.getoutline.org/sdk/transport/tlsfrag"
)

// TransportPairInfo is the app metadata for a whole transport config.
type TransportPairInfo struct {
	Stream, Packet ConnectionProviderInfo
}

// TransportPairParts is the built output of a transport config, before
// app policies (Outline DNS interception) are applied.
type TransportPairParts struct {
	StreamDialer   transport.StreamDialer
	PacketListener transport.PacketListener
}

// TransportPairConfig is a parsed transport strategy.
type TransportPairConfig interface {
	NewTransportPair(ctx context.Context) (*TransportPairParts, error)
}

// TCPUDPTransportConfig pairs independent TCP and UDP strategies.
type TCPUDPTransportConfig struct {
	TCP netconfig.StreamDialerConfig
	UDP netconfig.PacketListenerConfig
}

func (c *TCPUDPTransportConfig) NewTransportPair(ctx context.Context) (*TransportPairParts, error) {
	sd, err := c.TCP.NewStreamDialer(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build StreamDialer: %w", err)
	}
	pl, err := c.UDP.NewPacketListener(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build PacketListener: %w", err)
	}
	return &TransportPairParts{StreamDialer: sd, PacketListener: pl}, nil
}

const (
	minSplit = 6
	maxSplit = 64
)

// randomSplitLength returns a random number in [minSplit, maxSplit].
// splitLength includes 5 bytes of TLS header.
func randomSplitLength() int {
	return minSplit + rand.Intn(maxSplit+1-minSplit)
}

// BasicAccessTransportConfig is direct access with TLS fragmentation.
type BasicAccessTransportConfig struct{}

func (c *BasicAccessTransportConfig) NewTransportPair(ctx context.Context) (*TransportPairParts, error) {
	fragSD, err := tlsfrag.NewFixedLenStreamDialer(&transport.TCPDialer{}, randomSplitLength())
	if err != nil {
		return nil, fmt.Errorf("failed to create StreamDialer: %w", err)
	}
	return &TransportPairParts{StreamDialer: fragSD, PacketListener: &transport.UDPListener{}}, nil
}

// ShadowsocksTransportConfig is the legacy transport form: one
// shadowsocks config used for both TCP and UDP.
type ShadowsocksTransportConfig struct {
	StreamDialer   *netconfig.ShadowsocksStreamDialerConfig
	PacketListener *netconfig.ShadowsocksPacketListenerConfig
}

func (c *ShadowsocksTransportConfig) NewTransportPair(ctx context.Context) (*TransportPairParts, error) {
	sd, err := c.StreamDialer.NewStreamDialer(ctx)
	if err != nil {
		return nil, err
	}
	pl, err := c.PacketListener.NewPacketListener(ctx)
	if err != nil {
		return nil, err
	}
	return &TransportPairParts{StreamDialer: sd, PacketListener: pl}, nil
}

// withTransportInfo is withInfo for TransportPairInfo-valued metadata.
func withTransportInfo[Cfg any](parse composer.ParseFunc[Cfg], info func(ctx context.Context, cfg Cfg) (TransportPairInfo, error)) composer.ParseFunc[Cfg] {
	return func(ctx context.Context, node composer.Node) (Cfg, error) {
		var zero Cfg
		cfg, err := parse(ctx, node)
		if err != nil {
			return zero, err
		}
		i, err := info(ctx, cfg)
		if err != nil {
			return zero, err
		}
		if err := setInfo(ctx, cfg, i); err != nil {
			return zero, err
		}
		return cfg, nil
	}
}

type tcpudpFields struct {
	TCP composer.Optional[composer.Node]
	UDP composer.Optional[composer.Node]
}

// NewComposerTransportParser builds the full transport parser with
// Outline metadata attached to every node.
func NewComposerTransportParser(directSD transport.StreamDialer, directPD transport.PacketDialer) *composer.TypeParser[TransportPairConfig] {
	tables := newRegistryTables(directSD, directPD)

	parseShadowsocksTransport := func(ctx context.Context, node composer.Node) (*ShadowsocksTransportConfig, error) {
		sdParse := netconfig.NewShadowsocksStreamDialerParser(tables.streamEndpoints.Parse)
		plParse := netconfig.NewShadowsocksPacketListenerParser(tables.packetEndpoints.Parse)
		sd, err := sdParse(ctx, node)
		if err != nil {
			return nil, err
		}
		pl, err := plParse(ctx, node)
		if err != nil {
			return nil, err
		}
		return &ShadowsocksTransportConfig{StreamDialer: sd, PacketListener: pl}, nil
	}
	ssTransportInfo := func(ctx context.Context, cfg *ShadowsocksTransportConfig) (TransportPairInfo, error) {
		sdEP, err := requireInfo(ctx, cfg.StreamDialer.Endpoint)
		if err != nil {
			return TransportPairInfo{}, err
		}
		plEP, err := requireInfo(ctx, cfg.PacketListener.Endpoint)
		if err != nil {
			return TransportPairInfo{}, err
		}
		return TransportPairInfo{
			Stream: ConnectionProviderInfo{ConnTypeTunneled, sdEP.FirstHop},
			Packet: ConnectionProviderInfo{ConnTypeTunneled, plEP.FirstHop},
		}, nil
	}

	transports := composer.NewTypeParser(func(ctx context.Context, node composer.Node) (TransportPairConfig, error) {
		if node.IsAbsent() {
			return nil, errors.New("transport config missing")
		}
		// Legacy compatibility: no $type means shadowsocks (URL or mapping).
		cfg, err := withTransportInfo(parseShadowsocksTransport, ssTransportInfo)(ctx, node)
		if err != nil {
			return nil, err
		}
		return cfg, nil
	})

	tcpudpParse := func(ctx context.Context, node composer.Node) (*TCPUDPTransportConfig, error) {
		var f tcpudpFields
		if err := node.Decode(&f); err != nil {
			return nil, fmt.Errorf("invalid config format: %w", err)
		}
		tcpNode, _ := f.TCP.Get()
		sd, err := tables.streamDialers.Parse(ctx, tcpNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse StreamDialer: %w", err)
		}
		udpNode, _ := f.UDP.Get()
		pl, err := tables.packetListeners.Parse(ctx, udpNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse PacketListener: %w", err)
		}
		return &TCPUDPTransportConfig{TCP: sd, UDP: pl}, nil
	}
	transports.RegisterSubParser("tcpudp", asTransport(withTransportInfo(tcpudpParse,
		func(ctx context.Context, cfg *TCPUDPTransportConfig) (TransportPairInfo, error) {
			sdInfo, err := requireInfo(ctx, cfg.TCP)
			if err != nil {
				return TransportPairInfo{}, err
			}
			plInfo, err := requireInfo(ctx, cfg.UDP)
			if err != nil {
				return TransportPairInfo{}, err
			}
			return TransportPairInfo{Stream: sdInfo, Packet: plInfo}, nil
		})))

	basicAccessParse := func(ctx context.Context, node composer.Node) (*BasicAccessTransportConfig, error) {
		var f struct{}
		if err := node.Decode(&f); err != nil {
			return nil, fmt.Errorf("invalid config format: %w", err)
		}
		return &BasicAccessTransportConfig{}, nil
	}
	transports.RegisterSubParser("basic-access", asTransport(withTransportInfo(basicAccessParse,
		func(ctx context.Context, cfg *BasicAccessTransportConfig) (TransportPairInfo, error) {
			direct := ConnectionProviderInfo{ConnTypeDirect, ""}
			return TransportPairInfo{Stream: direct, Packet: direct}, nil
		})))

	return transports
}

func asTransport[Cfg TransportPairConfig](p composer.ParseFunc[Cfg]) composer.ParseFunc[TransportPairConfig] {
	return func(ctx context.Context, node composer.Node) (TransportPairConfig, error) {
		cfg, err := p(ctx, node)
		if err != nil {
			return nil, err
		}
		return cfg, nil
	}
}
```

`client/go/outline/configregistry/outline_dns.go` — copy the body of `wrapTransportPairWithOutlineDNS` from `outline_dns_intercept.go` (lines 52–104) into:

```go
// NewOutlineDNSTransport applies Outline's DNS policy to a built
// transport: it intercepts DNS at a link-local address over TCP and
// UDP, forwards to a randomly selected public resolver, and downgrades
// to truncated UDP responses (forcing TCP retry) while UDP
// connectivity is unverified. Returns the wrapped stream dialer, the
// packet relay, and the network-change callback.
func NewOutlineDNSTransport(sd transport.StreamDialer, pl transport.PacketListener) (transport.StreamDialer, packetrelay.PacketRelay, func(), error)
```

Adapt only the input/output plumbing: `sd.Dial` becomes `sd.DialStream`, `pl.PacketListener` becomes `pl`, and the return is `(transport.FuncStreamDialer(sdForward), relayMain, onNetworkChanged, nil)` instead of a `*TransportPair`. The resolver list and `linkLocalDNS` constants move here too (keep the same values; the legacy file keeps its own copies until deletion — to avoid a duplicate-symbol clash, suffix the moved ones: `outlineDNSResolversV2`, `linkLocalDNSV2`, then rename in Task 12 when the legacy file is deleted).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/outline/configregistry/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go/outline/configregistry && git add client/go/outline/configregistry
git commit -m "feat(client/go): add composer transport-pair configs and relocated DNS wrap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: reporting parser on composer

**Files:**
- Modify: `client/go/outline/reporting/config.go`
- Test: `client/go/outline/reporting/config_test.go` (create if missing; check for an existing one first and extend it)

**Interfaces:**
- Produces: `NewHTTPReporterConfigParser(cookiesFilename string, streamDialer transport.StreamDialer) composer.ParseFunc[Reporter]` (signature moves from `func(ctx, map[string]any)` to `composer.ParseFunc[Reporter]`).

- [ ] **Step 1: Write the failing test**

`client/go/outline/reporting/config_test.go`:

```go
package reporting

import (
	"context"
	"testing"
	"time"

	"localhost/client/go/composer"
	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
)

func parseReporter(t *testing.T, text string) (Reporter, error) {
	t.Helper()
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	parse := NewHTTPReporterConfigParser("", &transport.TCPDialer{})
	return parse(context.Background(), node)
}

func TestHTTPReporter_Parse(t *testing.T) {
	r, err := parseReporter(t, `
request:
  url: https://collector.example.com/report
  method: PUT
  headers:
    X-Thing: [a, b]
  body: "hello"
interval: 2h
`)
	require.NoError(t, err)
	hr := r.(*HTTPReporter)
	require.Equal(t, 2*time.Hour, hr.Interval)
	req, err := hr.NewRequest()
	require.NoError(t, err)
	require.Equal(t, "PUT", req.Method)
	require.Equal(t, []string{"a", "b"}, req.Header["X-Thing"])
}

func TestHTTPReporter_Defaults(t *testing.T) {
	r, err := parseReporter(t, "request:\n  url: https://collector.example.com/report")
	require.NoError(t, err)
	req, err := r.(*HTTPReporter).NewRequest()
	require.NoError(t, err)
	require.Equal(t, "POST", req.Method)
}

func TestHTTPReporter_Validation(t *testing.T) {
	_, err := parseReporter(t, "request:\n  url: https://c.example.com\ninterval: 10m")
	require.Error(t, err, "interval under 1h rejected")

	_, err = parseReporter(t, "request:\n  url: https://c.example.com\nenable_cookies: true")
	require.Error(t, err, "cookies without filename rejected")

	_, err = parseReporter(t, "request:\n  url: https://c.example.com\nsurprise: 1")
	require.Error(t, err, "unknown field rejected")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./client/go/outline/reporting/... 2>&1 | tail -3`
Expected: FAIL (signature mismatch / compile error).

- [ ] **Step 3: Implement**

Rewrite the config structs and parser head of `reporting/config.go` (keep the HTTP client, cookie jar, request factory, and interval logic bodies as they are — only the decode changes):

```go
type HTTPRequestConfig struct {
	URL     string
	Method  composer.Optional[string]
	Headers composer.Optional[map[string][]string]
	Body    composer.Optional[string]
}

type HTTPReporterConfig struct {
	Request       HTTPRequestConfig
	Interval      composer.Optional[string]
	EnableCookies composer.Optional[bool]
}

func NewHTTPReporterConfigParser(cookiesFilename string, streamDialer transport.StreamDialer) composer.ParseFunc[Reporter] {
	return func(ctx context.Context, node composer.Node) (Reporter, error) {
		var config HTTPReporterConfig
		if err := node.Decode(&config); err != nil {
			return nil, fmt.Errorf("invalid config format: %w", err)
		}
		// ... existing body, with these substitutions:
		//   config.Enable_Cookies        -> config.EnableCookies.Or(false)
		//   config.Request.Method == ""  -> config.Request.Method.Or("POST") (drop the inline default)
		//   config.Request.Body != ""    -> body, ok := config.Request.Body.Get()
		//   config.Request.Headers range -> config.Request.Headers.Or(nil)
		//   config.Interval != ""        -> interval, ok := config.Interval.Get()
	}
}
```

Replace the `localhost/client/go/configyaml` import with `localhost/client/go/composer`. Field-by-field: `url` stays required (decode fails when missing — the old code only checked parseability). Wire names are unchanged (`enable_cookies` matches `EnableCookies` by normalization).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./client/go/outline/reporting/...`
Expected: PASS. Note: `client.go` still calls the old signature and now breaks — expected mid-migration; fix is Task 10. Verify only the reporting package here; `go build ./client/go/outline/` failing is acceptable until Task 10. If the repo-wide build must stay green for CI, squash Tasks 9–10 into one commit at the end of Task 10 instead.

- [ ] **Step 5: Commit** (only if `go build ./client/go/...` still passes; otherwise defer this commit to the end of Task 10)

```bash
gofmt -w client/go/outline/reporting && git add client/go/outline/reporting
git commit -m "feat(client/go): port reporting config parser to composer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: client.go switchover (two-phase parse/build)

**Files:**
- Modify: `client/go/outline/client.go`, `client/go/outline/electron/main.go:133`, `client/go/outline/vpn_linux.go:66`, `client/go/outline/client_test.go`

**Interfaces:**
- Consumes: `NewComposerTransportParser`, `TransportPairConfig`, `TransportPairInfo`, `NewOutlineDNSTransport`, connmeta, reporting parser (Task 9).
- Produces (consumed by Task 11):

```go
type ParsedClient struct {
	Transport    TransportPairConfig        // configregistry types
	Info         configregistry.TransportPairInfo
	reporterNode composer.Node              // absent if none
	keyID        string
	dataDir      string
}
func (c *ClientConfig) ParseConfig(keyID, providerClientConfigText string) (*ParsedClient, error)
func (p *ParsedClient) NewClient() (*Client, error)
// preserved: func (c *ClientConfig) New(keyID, providerClientConfigText string) *NewClientResult
```

- [ ] **Step 1: Rewrite client.go**

Key changes (full replacement bodies):

```go
// ClientConfig is used to create a session Client.
type ClientConfig struct {
	DataDir         string
	TransportParser *composer.TypeParser[configregistry.TransportPairConfig]
}

// Client fields become:
type Client struct {
	sd            transport.StreamDialer
	sdInfo        configregistry.ConnectionProviderInfo
	pr            packetrelay.PacketRelay
	prInfo        configregistry.ConnectionProviderInfo
	notifyNetworkChanged func()
	reporter      reporting.Reporter
	sessionCancel context.CancelFunc
}

func (c *Client) DialStream(ctx context.Context, address string) (transport.StreamConn, error) {
	return c.sd.DialStream(ctx, address)
}

func (c *Client) NewAssociation() (packetrelay.PacketSender, packetrelay.PacketReceiver, error) {
	return c.pr.NewAssociation()
}

func (c *Client) NotifyNetworkChanged() {
	if c.notifyNetworkChanged != nil {
		c.notifyNetworkChanged()
	}
}

// The old exported ProviderClientConfig struct is replaced by the
// unexported inline decode struct inside ParseConfig below. Delete the
// old type. It has ONE external user: parse.go embeds it in
// ProviderTunnelConfig purely to give the lenient goccy unmarshal a
// shape — but doParseTunnelConfig only ever reads the Error field, so
// also delete ProviderTunnelConfig there and reduce providerConfig to:
//   type providerConfig struct { ProviderErrorConfig `yaml:",inline"` }
// (goccy ignores unknown fields by default; behavior is unchanged).

func (c *ClientConfig) ParseConfig(keyID, providerClientConfigText string) (*ParsedClient, error) {
	parser := c.TransportParser
	if parser == nil {
		tcpDialer := &transport.TCPDialer{Dialer: net.Dialer{KeepAlive: -1}}
		udpDialer := &transport.UDPDialer{}
		parser = configregistry.NewComposerTransportParser(tcpDialer, udpDialer)
	}
	dataDir := c.DataDir
	if dataDir == "" && runtime.GOOS != "android" && runtime.GOOS != "ios" {
		if userDir, err := os.UserConfigDir(); err == nil {
			dataDir = path.Join(userDir, "org.getoutline.client")
		} else {
			slog.Error("failed to get user config dir", "err", err)
		}
	}

	root, err := composer.ParseYAML([]byte(providerClientConfigText))
	if err != nil {
		return nil, &platerrors.PlatformError{Code: platerrors.InvalidConfig,
			Message: "config is not valid YAML", Cause: platerrors.ToPlatformError(err)}
	}
	var providerConfig struct {
		Transport composer.Node
		Reporter  composer.Optional[composer.Node]
	}
	if err := root.Decode(&providerConfig); err != nil {
		return nil, &platerrors.PlatformError{Code: platerrors.InvalidConfig,
			Message: "invalid config", Cause: platerrors.ToPlatformError(err)}
	}

	ctx, table := connmeta.WithTable(context.Background())
	transportCfg, err := parser.Parse(ctx, providerConfig.Transport)
	if err != nil {
		code := platerrors.InvalidConfig
		msg := "failed to create transport"
		if errors.Is(err, errors.ErrUnsupported) {
			msg = "unsupported config"
		}
		return nil, &platerrors.PlatformError{Code: code, Message: msg, Cause: platerrors.ToPlatformError(err)}
	}
	info, ok := connmeta.Get[configregistry.TransportPairInfo](table, transportCfg)
	if !ok {
		return nil, &platerrors.PlatformError{Code: platerrors.InternalError,
			Message: "missing connection info for transport config"}
	}
	reporterNode, _ := providerConfig.Reporter.Get()
	return &ParsedClient{Transport: transportCfg, Info: info,
		reporterNode: reporterNode, keyID: keyID, dataDir: dataDir}, nil
}

func (p *ParsedClient) NewClient() (*Client, error) {
	parts, err := p.Transport.NewTransportPair(context.Background())
	if err != nil {
		return nil, &platerrors.PlatformError{Code: platerrors.InvalidConfig,
			Message: "failed to create transport", Cause: platerrors.ToPlatformError(err)}
	}
	sd, relay, onNetworkChanged, err := configregistry.NewOutlineDNSTransport(parts.StreamDialer, parts.PacketListener)
	if err != nil {
		return nil, &platerrors.PlatformError{Code: platerrors.InternalError,
			Message: "failed to set up DNS handling", Cause: platerrors.ToPlatformError(err)}
	}
	client := &Client{sd: sd, sdInfo: p.Info.Stream, pr: relay, prInfo: p.Info.Packet,
		notifyNetworkChanged: onNetworkChanged}

	if !p.reporterNode.IsAbsent() {
		cookieFilename := ""
		if p.dataDir != "" {
			cookieFilename = path.Join(p.dataDir, "services", p.keyID, "cookies.json")
		}
		reporter, err := NewReporterParser(cookieFilename, client).Parse(context.Background(), p.reporterNode)
		if err != nil {
			return nil, &platerrors.PlatformError{Code: platerrors.InvalidConfig,
				Message: "invalid reporter config", Cause: platerrors.ToPlatformError(err)}
		}
		client.reporter = reporter
	}
	return client, nil
}

func (c *ClientConfig) New(keyID string, providerClientConfigText string) *NewClientResult {
	parsed, err := c.ParseConfig(keyID, providerClientConfigText)
	if err != nil {
		return &NewClientResult{Error: platerrors.ToPlatformError(err)}
	}
	client, err := parsed.NewClient()
	if err != nil {
		return &NewClientResult{Error: platerrors.ToPlatformError(err)}
	}
	return &NewClientResult{Client: client}
}

func NewReporterParser(cookiesFilename string, streamDialer transport.StreamDialer) *composer.TypeParser[reporting.Reporter] {
	parser := composer.NewTypeParser(func(ctx context.Context, node composer.Node) (reporting.Reporter, error) {
		return nil, errors.New("parser not specified")
	})
	// first-supported is built into composer.NewTypeParser.
	parser.RegisterSubParser("http", reporting.NewHTTPReporterConfigParser(cookiesFilename, streamDialer))
	return parser
}
```

Cross-check against the current file while editing: keep `StartSession`/`EndSession` bodies, `NewClientResult`, and the `Client` doc comment (update the stale TODO about PacketListener). Note `ParsedClient` returns `error` (interface); `New` re-wraps via `platerrors.ToPlatformError` which passes `*PlatformError` through unchanged.

- [ ] **Step 2: Update the two external construction sites**

`client/go/outline/electron/main.go:133` and `client/go/outline/vpn_linux.go:66`:

```go
clientConfig.TransportParser = configregistry.NewComposerTransportParser(tcp, udp)
```

(Imports for `configyaml` in those files, if any, get removed.)

- [ ] **Step 3: Update client_test.go**

Read `client/go/outline/client_test.go` and adapt: tests asserting on `client.sd.ConnectionProviderInfo` change to `client.sdInfo`; construction paths are unchanged (`ClientConfig.New`). Keep every existing scenario passing.

- [ ] **Step 4: Build and test**

Run: `go build ./client/go/... && go test ./client/go/outline/... ./client/go/netconfig/... ./client/go/composer/...`
Expected: all PASS. (`parse.go` still compiles — it consumes `Client` fields via the old names only in `doParseTunnelConfig`, updated next task; if it references removed fields, fix it minimally here and fully in Task 11.)

- [ ] **Step 5: Commit**

```bash
gofmt -w client/go && git add client/go
git commit -m "feat(client/go): switch client to two-phase composer parsing with app-side DNS policy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: parse.go — first-hop endpoint without building

**Files:**
- Modify: `client/go/outline/parse.go` (function `doParseTunnelConfig`, lines 147–167), `client/go/outline/parse_test.go`

- [ ] **Step 1: Rewrite the tail of doParseTunnelConfig**

Replace the client-building block (lines 147–167) with parse-only:

```go
	parsed, err := (&ClientConfig{
		DataDir: GetBackendConfig().DataDir,
	}).ParseConfig("", string(clientConfigBytes))
	if err != nil {
		return &InvokeMethodResult{Error: platerrors.ToPlatformError(err)}
	}
	response := firstHopAndTunnelConfigJSON{
		Client: string(clientConfigBytes),
	}
	if parsed.Info.Stream.FirstHop == parsed.Info.Packet.FirstHop {
		response.FirstHop = parsed.Info.Stream.FirstHop
	}
	response.ConnectionType = combinedConnectionType(parsed.Info.Stream.ConnType, parsed.Info.Packet.ConnType)
```

Everything above (input normalization, provider error handling) is unchanged. This removes the side-effectful client construction from the parse path — the design's dry-run payoff.

- [ ] **Step 2: Update parse_test.go**

Read and adapt `client/go/outline/parse_test.go`: expected JSON outputs are unchanged (same fields, same ConnType strings); only failures caused by construction-time behavior may shift — investigate any test that starts failing and confirm the new behavior is parse-only and correct.

- [ ] **Step 3: Test**

Run: `go test ./client/go/outline/...`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
gofmt -w client/go/outline && git add client/go/outline
git commit -m "feat(client/go): compute first-hop config info without building a client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: delete the legacy config system

**Files:**
- Delete: `client/go/configyaml/` (entire package)
- Delete from `client/go/outline/configregistry/`: `registry.go`, `registry_test.go`, `config_shadowsocks.go`, `config_shadowsocks_test.go`, `config_websocket.go`, `config_dial_endpoint.go`, `config_block.go`, `config_block_test.go`, `config_first_supported.go`, `config_iptable.go`, `config_iptable_test.go`, `config_tcpudp.go`, `config_proxyless.go`, `config_proxyless_test.go`, `outline_dns_intercept.go`
- Modify: `client/go/outline/configregistry/types.go`, `client/go/outline/configregistry/outline_dns.go`

- [ ] **Step 1: Check for stragglers before deleting**

```bash
rg -l "configyaml" client/ --glob '*.go'
rg -n "decodeUTF8CodepointsToRawBytes" client/go --glob '*.go'
```

Expected: only the files being deleted. `utf8.go`/`utf8_test.go`: if `decodeUTF8CodepointsToRawBytes` is referenced only by deleted files or duplicates `parseStringPrefix` (it does — compare), delete both files; otherwise move them to netconfig.

- [ ] **Step 2: Delete and clean**

```bash
git rm -r client/go/configyaml
git rm client/go/outline/configregistry/registry.go client/go/outline/configregistry/registry_test.go \
  client/go/outline/configregistry/config_shadowsocks.go client/go/outline/configregistry/config_shadowsocks_test.go \
  client/go/outline/configregistry/config_websocket.go client/go/outline/configregistry/config_dial_endpoint.go \
  client/go/outline/configregistry/config_block.go client/go/outline/configregistry/config_block_test.go \
  client/go/outline/configregistry/config_first_supported.go \
  client/go/outline/configregistry/config_iptable.go client/go/outline/configregistry/config_iptable_test.go \
  client/go/outline/configregistry/config_tcpudp.go \
  client/go/outline/configregistry/config_proxyless.go client/go/outline/configregistry/config_proxyless_test.go \
  client/go/outline/configregistry/outline_dns_intercept.go
```

Then:
- In `types.go`: delete the now-unused `Dialer[ConnType]`, `Endpoint[ConnType]`, `DialFunc`, `ConnectFunc`, `PacketListener`, `PacketRelay`, and `TransportPair` types IF nothing references them (`rg -n "configregistry\.(Dialer|Endpoint|PacketListener|PacketRelay|TransportPair)\b" client/`); keep `ConnType`, `ConnectionProviderInfo`, and the `MarshalJSON`. Whatever `vpn`/`tun2socks` still reference, keep and note.
- In `outline_dns.go`: rename `outlineDNSResolversV2` → `outlineDNSResolvers`, `linkLocalDNSV2` → `linkLocalDNS`.

- [ ] **Step 3: Full verification**

```bash
go build ./client/go/... && go test ./client/go/... && go vet ./client/go/...
rg -n "configyaml" client/ ; test $? -eq 1 && echo NO-STRAGGLERS
```

Expected: build/test/vet clean, NO-STRAGGLERS. Also run the mobile/desktop Go build actions if available locally: `npm run action client/go/build 2>/dev/null || true` (informational).

- [ ] **Step 4: Commit**

```bash
git add -A client/go && git commit -m "refactor(client/go)!: delete legacy configyaml and configregistry parsers

The composer-based system (composer + netconfig + connmeta) replaces
them entirely.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: golden corpus and fuzz target

**Files:**
- Create: `client/go/outline/configregistry/corpus_test.go`, `client/go/composer/fuzz_test.go`

- [ ] **Step 1: Corpus test**

`corpus_test.go`: table-driven test that parses every config format documented at https://developer.getoutline.org/vpn/reference/access-key-config/ (fetch the page while implementing and transcribe each example) plus these known-deployed forms, asserting parse success and expected `TransportPairInfo`:

```go
func TestCorpus_DocumentedConfigs(t *testing.T) {
	tests := []struct {
		name, yaml               string
		wantStream, wantPacket   ConnType
		wantStreamHop            string
	}{
		{"ss URL", `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`, ConnTypeTunneled, ConnTypeTunneled, "example.com:1234"},
		{"legacy JSON", `{"server": "example.com", "server_port": 1234, "method": "chacha20-ietf-poly1305", "password": "SECRET"}`, ConnTypeTunneled, ConnTypeTunneled, "example.com:1234"},
		{"tcpudp with merge keys", `
$type: tcpudp
tcp: &shared
  $type: shadowsocks
  endpoint: example.com:1234
  cipher: chacha20-ietf-poly1305
  secret: SECRET
udp: *shared
`, ConnTypeTunneled, ConnTypeTunneled, "example.com:1234"},
		// + every remaining documented example, including websocket and
		// first-supported forms and the tcp/udp merge-key (<<) example.
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg, table := parseTransport(t, tc.yaml)
			info := requirePairInfo(t, table, cfg)
			require.Equal(t, tc.wantStream, info.Stream.ConnType)
			require.Equal(t, tc.wantPacket, info.Packet.ConnType)
			require.Equal(t, tc.wantStreamHop, info.Stream.FirstHop)
		})
	}
}
```

- [ ] **Step 2: Fuzz target**

`client/go/composer/fuzz_test.go`:

```go
package composer

import "testing"

func FuzzParseAndDecode(f *testing.F) {
	f.Add("a: 1")
	f.Add("$type: x\nlist: [1, {b: c}]\nk?: v")
	f.Add("x: &a [*b]\nb: &b 1")
	f.Add("a: &m\n  <<: *m")
	f.Fuzz(func(t *testing.T, text string) {
		node, err := ParseYAML([]byte(text))
		if err != nil {
			return
		}
		var out map[string]Node
		_ = node.Decode(&out) // must not panic or hang
	})
}
```

Run: `go test ./client/go/composer/ -run FuzzParseAndDecode -fuzz FuzzParseAndDecode -fuzztime 30s` once; then it runs as a normal seed-corpus test in CI.

- [ ] **Step 3: Test and commit**

```bash
go test ./client/go/...
gofmt -w client/go && git add client/go
git commit -m "test(client/go): add config corpus and composer fuzz target

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: documentation

**Files:**
- Modify: `client/go/outline/configregistry/README.md` (full rewrite of Overview/Core concepts/Adding-a-strategy sections for the composer architecture: netconfig configs + `New`, connmeta wrappers, where policies live; delete the migration-note section added in July)
- Create: `client/go/netconfig/AGENTS.md` (mirror `client/go/composer/AGENTS.md` structure: how to add a config type here vs in the app; the no-app-imports rule)
- Modify: `client/go/composer/AGENTS.md` (Status section: legacy configyaml deleted; netconfig is the transport layer)
- Modify: `client/go/composer/DESIGN.md` (D12: mark migration complete with date)

- [ ] **Step 1: Write the docs** (rewrite content per the parenthetical notes above; keep each file's existing voice and length discipline)

- [ ] **Step 2: Final verification and commit**

```bash
go test ./client/go/... && go vet ./client/go/...
git add client/go docs && git commit -m "docs(client/go): document the composer-based config architecture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope

- The Outline SDK move (lifting composer + netconfig into outline-sdk; `x/configurl` reconciliation) — separate effort in the SDK repo.
- Any wire-format changes; this plan is behavior-preserving except: parse-time side effects moved to build, and `parse.go` no longer constructs a client.
