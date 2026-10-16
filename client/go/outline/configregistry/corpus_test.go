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

package configregistry

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
	"localhost/client/go/composer/registry"
)

// TestCorpus_DocumentedConfigs parses every config example documented at
// https://developer.getoutline.org/vpn/reference/access-key-config/ (fetched
// and cross-checked against the raw page source on 2026-07-09) that is a
// complete, standalone transport config, plus a couple of known-deployed
// forms. Each entry is transcribed from the page; where the page wraps an
// example in a top-level `transport:` key, that wrapper is stripped,
// matching how parseTransport (and the production parser) is invoked
// directly on the TransportConfig node. Where a page example is not a
// complete config by itself (e.g. the TCPUDPConfig section's bare
// `tcp:`/`udp:` fields, or a `# ... udp config` placeholder comment), a
// concrete wrapper or substitution is added; each is called out in the
// comment above the row.
//
// Two code blocks on the page are deliberately NOT transcribed here:
//   - The ExplicitTunnelConfig section's "Successful"/"Error" examples
//     describe the TunnelConfig layer *above* transport (a `transport:` or
//     mutually-exclusive `error:` object at the document root). Our
//     parseTransport helper - like the production parser it wraps - parses
//     a TransportConfig node directly, one layer below that; those two
//     examples aren't inputs to it.
//   - The FirstSupportedConfig "Meta Definitions" example is a bare
//     `options:` fragment, not a complete config; its shape (a websocket
//     option, then a bare host:port fallback) is exercised below by the
//     "first-supported cross-platform compatibility" row instead of being
//     duplicated.
//
// Examples whose documented shape does not parse against this
// implementation are intentionally NOT here either: see
// TestCorpus_DocumentedConfigs_KnownGaps.
func TestCorpus_DocumentedConfigs(t *testing.T) {
	tests := []struct {
		name, yaml                   string
		wantStream, wantPacket       ConnType
		wantStreamHop, wantPacketHop string
	}{
		{"ss URL", `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`, ConnTypeTunneled, ConnTypeTunneled, "example.com:1234", "example.com:1234"},
		{"legacy JSON", `{"server": "example.com", "server_port": 1234, "method": "chacha20-ietf-poly1305", "password": "SECRET"}`, ConnTypeTunneled, ConnTypeTunneled, "example.com:1234", "example.com:1234"},
		{"tcpudp with merge keys", `
$type: tcpudp
tcp: &shared
  $type: shadowsocks
  endpoint: example.com:1234
  cipher: chacha20-ietf-poly1305
  secret: SECRET
udp: *shared
`, ConnTypeTunneled, ConnTypeTunneled, "example.com:1234", "example.com:1234"},

		// --- Everything below is transcribed from the docs page. ---

		// "Examples" section, "Basic Shadowsocks Configuration". The page
		// wraps this in a `transport:` key; stripped here as noted above.
		{"docs: basic shadowsocks configuration", `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint: ss.example.com:4321
  cipher: chacha20-ietf-poly1305
  secret: SECRET
  prefix: "POST "
udp:
  $type: shadowsocks
  endpoint: ss.example.com:4321
  cipher: chacha20-ietf-poly1305
  secret: SECRET
`, ConnTypeTunneled, ConnTypeTunneled, "ss.example.com:4321", "ss.example.com:4321"},

		// "Examples" section, "YAML Anchors with Merge Key": the tcp field
		// uses `<<: &shared` to merge a shadowsocks mapping and add a
		// sibling `prefix` key; udp reuses the whole anchor via `*shared`.
		{"docs: yaml anchors with merge key", `
$type: tcpudp
tcp:
  <<: &shared
    $type: shadowsocks
    endpoint: ss.example.com:4321
    cipher: chacha20-ietf-poly1305
    secret: SECRET
  prefix: "POST "
udp: *shared
`, ConnTypeTunneled, ConnTypeTunneled, "ss.example.com:4321", "ss.example.com:4321"},

		// "Examples" section, "Multi-Hop Configuration" is a KNOWN GAP:
		// see TestCorpus_DocumentedConfigs_KnownGaps. It is deliberately
		// omitted from this success table.

		// "Examples" section, "Shadowsocks over Websockets": no explicit
		// inner `endpoint`, so the websocket dials the URL's own host:port
		// directly.
		{"docs: shadowsocks over websockets", `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint:
      $type: websocket
      url: wss://legendary-faster-packs-und.trycloudflare.com/SECRET_PATH/tcp
  cipher: chacha20-ietf-poly1305
  secret: SS_SECRET
udp:
  $type: shadowsocks
  endpoint:
      $type: websocket
      url: wss://legendary-faster-packs-und.trycloudflare.com/SECRET_PATH/udp
  cipher: chacha20-ietf-poly1305
  secret: SS_SECRET
`, ConnTypeTunneled, ConnTypeTunneled, "legendary-faster-packs-und.trycloudflare.com:443", "legendary-faster-packs-und.trycloudflare.com:443"},

		// "Examples" section, "Websocket with Custom Endpoint": explicit
		// inner `endpoint` overrides the URL host, so the websocket
		// TCP-connects to that address instead.
		{"docs: websocket with custom endpoint", `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint:
      $type: websocket
      url: wss://legendary-faster-packs-und.trycloudflare.com/SECRET_PATH/tcp
      endpoint: cloudflare.net:443
  cipher: chacha20-ietf-poly1305
  secret: SS_SECRET
udp:
  $type: shadowsocks
  endpoint:
      $type: websocket
      url: wss://legendary-faster-packs-und.trycloudflare.com/SECRET_PATH/udp
      endpoint: cloudflare.net:443
  cipher: chacha20-ietf-poly1305
  secret: SS_SECRET
`, ConnTypeTunneled, ConnTypeTunneled, "cloudflare.net:443", "cloudflare.net:443"},

		// "Examples" section, "First-Supported (Cross-Platform
		// Compatibility)". This also transcribes the "FirstSupportedConfig"
		// meta-definition section, which shows the same two-option shape
		// (`websocket` then a bare host:port) as a generic fragment rather
		// than a full config; it is represented here rather than
		// duplicated. The websocket option parses successfully (no network
		// I/O happens at parse time), so first-supported picks it.
		{"docs: first-supported cross-platform compatibility", `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint:
    $type: first-supported
    options:
      - $type: websocket
        url: wss://legendary-faster-packs-und.trycloudflare.com/SECRET_PATH/tcp
      - ss.example.com:4321
  cipher: chacha20-ietf-poly1305
  secret: SS_SECRET
udp:
  $type: shadowsocks
  endpoint:
    $type: first-supported
    options:
      - $type: websocket
        url: wss://legendary-faster-packs-und.trycloudflare.com/SECRET_PATH/udp
      - ss.example.com:4321
  cipher: chacha20-ietf-poly1305
  secret: SS_SECRET
`, ConnTypeTunneled, ConnTypeTunneled, "legendary-faster-packs-und.trycloudflare.com:443", "legendary-faster-packs-und.trycloudflare.com:443"},

		// "TCPUDPConfig" section, "TCP/UDP to Different Endpoints": tcp and
		// udp point at different ports of the same host, sharing
		// cipher/secret via `<<: &cipher` / `<<: *cipher`. This is the
		// tcp/udp merge-key (<<) example distinct from the "YAML Anchors"
		// one above, since here the two sides have different `endpoint`s.
		// The page shows this as bare `tcp:`/`udp:` fields (illustrating
		// just the TCPUDPConfig struct's own fields, in isolation); wrapped
		// here in `$type: tcpudp` so it is a parseable top-level config.
		{"docs: tcp/udp to different endpoints (merge key)", `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint: ss.example.com:80
  <<: &cipher
    cipher: chacha20-ietf-poly1305
    secret: SECRET
  prefix: "POST "
udp:
  $type: shadowsocks
  endpoint: ss.example.com:53
  <<: *cipher
`, ConnTypeTunneled, ConnTypeTunneled, "ss.example.com:80", "ss.example.com:53"},

		// "LegacyShadowsocksConfig" section: same shape as the "legacy
		// JSON" seed row above, but as a YAML mapping with a `prefix`.
		{"docs: legacy shadowsocks config", `
server: example.com
server_port: 4321
method: chacha20-ietf-poly1305
password: SECRET
prefix: "POST "
`, ConnTypeTunneled, ConnTypeTunneled, "example.com:4321", "example.com:4321"},

		// "LegacyShadowsocksURI" section. The page's rendered example had
		// its `SECRET@example.com` user-info auto-linkified into a mailto
		// artifact by our fetch tooling; reconstructed here as plain
		// user-info, matching the SIP002/legacy `ss://` URL shapes already
		// exercised by "ss URL" above.
		{"docs: legacy shadowsocks URI", `"ss://chacha20-ietf-poly1305:SECRET@example.com:443?prefix=POST%20"`, ConnTypeTunneled, ConnTypeTunneled, "example.com:443", "example.com:443"},

		// "ShadowsocksConfig" section: the fields listing has no `$type`,
		// so it is parsed via the legacy (no-$type) fallback at the top
		// level, using its modern `endpoint` field.
		{"docs: shadowsocks config fields (no $type)", `
endpoint: example.com:80
cipher: chacha20-ietf-poly1305
secret: SECRET
prefix: "POST "
`, ConnTypeTunneled, ConnTypeTunneled, "example.com:80", "example.com:80"},

		// "Interface" section shows `$type: shadowsocks` as a generic
		// illustration of the $type pattern; used standalone at the top
		// level it is a KNOWN GAP (shadowsocks is not a registered
		// top-level transport type): see
		// TestCorpus_DocumentedConfigs_KnownGaps. Deliberately omitted here.

		// "IPTableConfig" section: blocks 192.0.2.0/24 on TCP and falls
		// back to direct for everything else; UDP is a plain shadowsocks
		// config. The page elides the udp config with a
		// `# ... udp config` comment; substituted with the same concrete
		// endpoint/cipher/secret used in the "docs: shadowsocks config
		// fields" row. The iptable dialer never records a FirstHop for
		// itself (aggregated ConnType only), so both hops are the direct
		// fallback's/shadowsocks endpoint's own values.
		{"docs: iptable selective routing", `
$type: tcpudp
tcp:
  $type: iptable
  table:
    - ips:
        - 192.0.2.0/24
      dialer:
        $type: block
  fallback:
    $type: direct
udp:
  $type: shadowsocks
  endpoint: example.com:1234
  cipher: chacha20-ietf-poly1305
  secret: SECRET
`, ConnTypeDirect, ConnTypeTunneled, "", "example.com:1234"},

		// "Utility Dialers" section, "Direct Dialer Example". The page
		// shows this as a bare `dialer: $type: direct` fragment; nested
		// here under tcpudp.tcp (the only place a bare DialerConfig is a
		// field) to make it a parseable, complete transport config. udp is
		// omitted and defaults to direct too.
		{"docs: direct dialer", `
$type: tcpudp
tcp:
  $type: direct
`, ConnTypeDirect, ConnTypeDirect, "", ""},

		// "Utility Dialers" section, "Block Dialer Example". Same
		// embedding rationale as the direct-dialer row above.
		{"docs: block dialer", `
$type: tcpudp
tcp:
  $type: block
`, ConnTypeBlocked, ConnTypeDirect, "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, info := parseTransportWithInfo(t, tc.yaml)
			require.Equal(t, tc.wantStream, info.Stream.ConnType)
			require.Equal(t, tc.wantPacket, info.Packet.ConnType)
			require.Equal(t, tc.wantStreamHop, info.Stream.FirstHop)
			require.Equal(t, tc.wantPacketHop, info.Packet.FirstHop)
		})
	}
}

// TestCorpus_DocumentedConfigs_KnownGaps records documented example shapes
// that FAIL to parse against this implementation. These are real findings
// about the composer migration, not test bugs: rather than deleting the
// examples or forcing them to parse, this test pins down today's error so
// a) the gap is visible in the corpus and b) a future fix that makes one of
// these parse will break this test, signalling that the row should move up
// into TestCorpus_DocumentedConfigs.
func TestCorpus_DocumentedConfigs_KnownGaps(t *testing.T) {
	tests := []struct {
		name, yaml, wantErrContains string
	}{
		// "Examples" section, "Multi-Hop Configuration", verified against
		// the raw page source (not just the rendered fetch) since it makes
		// a failure claim: the inner (entry-hop) shadowsocks dialer really
		// is documented with an `address` field (`$type: shadowsocks,
		// address: entry.example.com:4321, cipher, secret`). This appears
		// to be a bug in the doc example itself, not just a gap in our
		// parser: the page's own "ShadowsocksConfig" section (Strategies /
		// Shadowsocks) lists the field as `endpoint (EndpointConfig): the
		// Shadowsocks endpoint to connect to` - not `address`. `address` is
		// a field of the `dial` EndpointConfig (used one level up, for the
		// outer `endpoint: {$type: dial, address: ..., dialer: ...}`), not
		// of `shadowsocks`. Our ShadowsocksStreamDialerConfig mapping form
		// matches the schema reference (`endpoint`/`server`+`server_port`),
		// so this is the doc example, verbatim, disagreeing with the doc's
		// own field listing (with the `transport:` wrapper stripped as
		// elsewhere in this file).
		{
			name: "multi-hop configuration: nested shadowsocks dialer uses 'address' instead of 'endpoint'",
			yaml: `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint:
    $type: dial
    address: exit.example.com:4321
    dialer:
      $type: shadowsocks
      address: entry.example.com:4321
      cipher: chacha20-ietf-poly1305
      secret: ENTRY_SECRET
  cipher: chacha20-ietf-poly1305
  secret: EXIT_SECRET
udp:
  $type: shadowsocks
  endpoint: ss.example.com:4321
  cipher: chacha20-ietf-poly1305
  secret: SECRET
`,
			wantErrContains: `unknown field "address"`,
		},

		// "Interface" section's generic `$type: shadowsocks` illustration of
		// the $type pattern, tried standalone as a top-level transport
		// config (the page does not itself claim this is a valid
		// standalone TunnelConfig/TransportConfig - "Interface" is a
		// generic pattern description, not a TransportConfig example).
		// What this exposes is a real explicit-vs-implicit asymmetry in
		// the transport parser: a bare mapping with no `$type` at all
		// falls back to the legacy shadowsocks parser and succeeds (see
		// "docs: shadowsocks config fields (no $type)" above, which uses
		// the same fields), but writing `$type: shadowsocks` explicitly on
		// that same mapping fails, because "shadowsocks" is only
		// registered as a StreamDialerConfig/PacketDialerConfig/
		// PacketListenerConfig sub-parser (for use inside a tcpudp's tcp/
		// udp fields, or as a nested dialer), not as a top-level
		// TransportPairConfig: the app registry only registers
		// "tcpudp" and "basic-access" at that level, plus the legacy
		// (no-$type) fallback.
		{
			name: "interface pattern example: explicit top-level $type: shadowsocks is not a registered transport type (implicit/no-$type form works)",
			yaml: `
$type: shadowsocks
endpoint: example.com:4321
cipher: chacha20-ietf-poly1305
secret: SECRET
`,
			wantErrContains: `config type "shadowsocks" is not supported`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := registry.New()
			require.NoError(t, Register(r, &transport.TCPDialer{}, &transport.UDPDialer{}))
			parse := registry.Parser(r, TransportPairKind)
			node, err := composer.ParseYAML([]byte(tc.yaml))
			require.NoError(t, err)
			ctx := WithMetadataCollection(context.Background())
			_, err = parse(ctx, node)
			require.Error(t, err)
			require.ErrorContains(t, err, tc.wantErrContains)
		})
	}
}
