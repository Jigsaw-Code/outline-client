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
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
	"localhost/client/go/composer/netconfig"
	"localhost/client/go/composer/registry"
)

func parseNode(t *testing.T, text string) composer.Node {
	t.Helper()
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	return node
}

func parseSD(t *testing.T, text string) netconfig.StreamDialerConfig {
	t.Helper()
	cfg, _ := parseSDWithInfo(t, text)
	return cfg
}

func parseSDWithInfo(t *testing.T, text string) (netconfig.StreamDialerConfig, ConnectionProviderInfo) {
	t.Helper()
	r := registry.New()
	require.NoError(t, Register(r, &transport.TCPDialer{}, &transport.UDPDialer{}))
	ctx := WithMetadataCollection(context.Background())
	cfg, err := registry.Parser(r, netconfig.StreamDialerKind)(ctx, parseNode(t, text))
	require.NoError(t, err)
	info, err := requireConnectionInfo(ctx, cfg)
	require.NoError(t, err)
	return cfg, info
}

func TestMetadata_StreamDialerForms(t *testing.T) {
	tests := []struct {
		name string
		yaml string
		want ConnectionProviderInfo
	}{
		{"direct fallback", "", ConnectionProviderInfo{ConnType: ConnTypeDirect}},
		{"direct", "$type: direct", ConnectionProviderInfo{ConnType: ConnTypeDirect}},
		{"block", "$type: block", ConnectionProviderInfo{ConnType: ConnTypeBlocked}},
		{"first-supported", "$type: first-supported\noptions:\n  - {$type: warp-drive}\n  - {$type: block}", ConnectionProviderInfo{ConnType: ConnTypeBlocked}},
		{"scalar Shadowsocks", `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`, ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "example.com:1234"}},
		{"Shadowsocks", "$type: shadowsocks\nendpoint: example.com:1234\ncipher: chacha20-ietf-poly1305\nsecret: SECRET", ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "example.com:1234"}},
		{"WebSocket", "$type: shadowsocks\ncipher: chacha20-ietf-poly1305\nsecret: SECRET\nendpoint:\n  $type: websocket\n  url: wss://cdn.example.com/tcp", ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "cdn.example.com:443"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, info := parseSDWithInfo(t, test.yaml)
			require.Equal(t, test.want, info)
			if test.name == "WebSocket" {
				ss := cfg.(*netconfig.ShadowsocksStreamDialerConfig)
				ws := ss.Endpoint.(*netconfig.WebsocketEndpointConfig)
				require.NotEmpty(t, ws.Headers.Get("User-Agent"))
			}
		})
	}
}

func TestMetadata_PacketConfigForms(t *testing.T) {
	r := registry.New()
	require.NoError(t, Register(r, &transport.TCPDialer{}, &transport.UDPDialer{}))
	ctx := WithMetadataCollection(context.Background())
	shadowsocks := `
$type: shadowsocks
endpoint: example.com:1234
cipher: chacha20-ietf-poly1305
secret: SECRET
`
	tests := []struct {
		name  string
		parse func(composer.Node) (any, error)
		yaml  string
		want  ConnectionProviderInfo
	}{
		{"packet dialer direct", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketDialerKind)(ctx, node)
		}, "$type: direct", ConnectionProviderInfo{ConnType: ConnTypeDirect}},
		{"packet dialer block", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketDialerKind)(ctx, node)
		}, "$type: block", ConnectionProviderInfo{ConnType: ConnTypeBlocked}},
		{"packet dialer Shadowsocks", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketDialerKind)(ctx, node)
		}, shadowsocks, ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "example.com:1234"}},
		{"packet dialer scalar Shadowsocks", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketDialerKind)(ctx, node)
		}, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`, ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "example.com:1234"}},
		{"packet listener fallback", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketListenerKind)(ctx, node)
		}, "", ConnectionProviderInfo{ConnType: ConnTypeDirect}},
		{"packet listener direct", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketListenerKind)(ctx, node)
		}, "$type: direct", ConnectionProviderInfo{ConnType: ConnTypeDirect}},
		{"packet listener Shadowsocks", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketListenerKind)(ctx, node)
		}, shadowsocks, ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "example.com:1234"}},
		{"packet endpoint fallback", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketEndpointKind)(ctx, node)
		}, "example.com:53", ConnectionProviderInfo{ConnType: ConnTypeDirect, FirstHop: "example.com:53"}},
		{"packet endpoint dial", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketEndpointKind)(ctx, node)
		}, "$type: dial\naddress: example.com:53", ConnectionProviderInfo{ConnType: ConnTypeDirect, FirstHop: "example.com:53"}},
		{"packet endpoint WebSocket", func(node composer.Node) (any, error) {
			return registry.Parser(r, netconfig.PacketEndpointKind)(ctx, node)
		}, "$type: websocket\nurl: wss://cdn.example.com/udp", ConnectionProviderInfo{ConnType: ConnTypeDirect, FirstHop: "cdn.example.com:443"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := test.parse(parseNode(t, test.yaml))
			require.NoError(t, err)
			info, err := requireConnectionInfo(ctx, cfg)
			require.NoError(t, err)
			require.Equal(t, test.want, info)
		})
	}
}

// swapDirectResolver installs a test resolver and returns a restore func. Tests
// run sequentially within the package, so the package variable is safe to swap.
func swapDirectResolver(resolve func(context.Context, string) string) func() {
	prev := directAddressResolver
	directAddressResolver = resolve
	return func() { directAddressResolver = prev }
}

func TestMetadata_DialEndpointResolutionPolicy(t *testing.T) {
	r := registry.New()
	require.NoError(t, Register(r, &transport.TCPDialer{}, &transport.UDPDialer{}))
	resolveCalls := 0
	defer swapDirectResolver(func(context.Context, string) string {
		resolveCalls++
		return "203.0.113.7:443"
	})()
	ctx := WithMetadataCollection(context.Background())
	cfg, err := registry.Parser(r, netconfig.StreamEndpointKind)(ctx, parseNode(t, `
$type: dial
address: origin.example:443
dialer:
  $type: direct
`))
	require.NoError(t, err)
	dial := cfg.(*netconfig.StreamDialEndpointConfig)
	require.Equal(t, "203.0.113.7:443", dial.Address, "a direct endpoint's address is rewritten to the resolved form")
	info, err := requireConnectionInfo(ctx, cfg)
	require.NoError(t, err)
	require.Equal(t, ConnectionProviderInfo{ConnType: ConnTypeDirect, FirstHop: "203.0.113.7:443"}, info)
	require.Equal(t, 1, resolveCalls)

	child := &netconfig.ShadowsocksStreamDialerConfig{}
	require.NoError(t, storeConnectionInfo(ctx, child,
		ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "proxy.example:1234"}))
	tunneled := &netconfig.StreamDialEndpointConfig{Address: "ignored.example:443", Dialer: child}
	info, err = streamDialEndpointInfo(ctx, tunneled)
	require.NoError(t, err)
	require.Equal(t, "ignored.example:443", tunneled.Address, "a tunneled endpoint's address is not resolved")
	require.Equal(t, ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: "proxy.example:1234"}, info)

	// A resolver that cannot resolve returns the address unchanged.
	defer swapDirectResolver(func(_ context.Context, address string) string { return address })()
	failureContext := WithMetadataCollection(context.Background())
	directPacket := netconfig.NewDirectPacketDialerConfig(&transport.UDPDialer{})
	require.NoError(t, storeConnectionInfo(failureContext, directPacket,
		ConnectionProviderInfo{ConnType: ConnTypeDirect}))
	packet := &netconfig.PacketDialEndpointConfig{Address: "origin.example:53", Dialer: directPacket}
	info, err = packetDialEndpointInfo(failureContext, packet)
	require.NoError(t, err)
	require.Equal(t, "origin.example:53", packet.Address, "resolution failure leaves the hostname in place")
	require.Equal(t, ConnectionProviderInfo{ConnType: ConnTypeDirect, FirstHop: "origin.example:53"}, info)
}

func TestMetadata_ResolutionIsSharedAcrossTransportHalves(t *testing.T) {
	r := registry.New()
	require.NoError(t, Register(r, &transport.TCPDialer{}, &transport.UDPDialer{}))
	resolveCalls := 0
	defer swapDirectResolver(func(context.Context, string) string {
		resolveCalls++
		return "203.0.113.9:1234"
	})()
	ctx := WithMetadataCollection(context.Background())
	ctx = WithDirectDialResolution(ctx)
	cfg, err := registry.Parser(r, TransportPairKind)(ctx, parseNode(t, `
$type: tcpudp
tcp:
  $type: shadowsocks
  endpoint: origin.example:1234
  cipher: chacha20-ietf-poly1305
  secret: SECRET
udp:
  $type: shadowsocks
  endpoint: origin.example:1234
  cipher: chacha20-ietf-poly1305
  secret: SECRET
`))
	require.NoError(t, err)
	info, err := TransportMetadata(ctx, cfg)
	require.NoError(t, err)
	require.Equal(t, "203.0.113.9:1234", info.Stream.FirstHop)
	require.Equal(t, info.Stream.FirstHop, info.Packet.FirstHop)
	require.Equal(t, 1, resolveCalls)
}

type unannotatedStreamDialer struct{}

func (*unannotatedStreamDialer) NewStreamDialer(context.Context) (transport.StreamDialer, error) {
	return nil, nil
}

func TestMetadata_MissingChildIsInternalWiringError(t *testing.T) {
	r := registry.New()
	require.NoError(t, registry.Register(r, netconfig.StreamDialerKind, "unannotated",
		func(context.Context, composer.Node) (netconfig.StreamDialerConfig, error) {
			return &unannotatedStreamDialer{}, nil
		}))
	require.NoError(t, registry.Register(r, netconfig.StreamEndpointKind, "dial",
		streamEndpointParser(
			netconfig.NewStreamDialEndpointParser(registry.Parser(r, netconfig.StreamDialerKind)),
			streamDialEndpointInfo)))
	ctx := WithMetadataCollection(context.Background())
	_, err := registry.Parser(r, netconfig.StreamEndpointKind)(ctx, parseNode(t, `
$type: dial
address: example.com:443
dialer: {$type: unannotated}
`))
	require.ErrorIs(t, err, ErrMetadataWiring)
	require.ErrorContains(t, err, "no connection metadata")
}

func TestMetadata_OutlineParsersRequireCollector(t *testing.T) {
	r := registry.New()
	require.NoError(t, Register(r, &transport.TCPDialer{}, &transport.UDPDialer{}))
	tests := []struct {
		name  string
		parse func(context.Context, composer.Node) error
		yaml  string
	}{
		{"stream dialer named", func(ctx context.Context, node composer.Node) error {
			_, err := registry.Parser(r, netconfig.StreamDialerKind)(ctx, node)
			return err
		}, "$type: block"},
		{"stream dialer fallback", func(ctx context.Context, node composer.Node) error {
			_, err := registry.Parser(r, netconfig.StreamDialerKind)(ctx, node)
			return err
		}, ""},
		{"packet dialer named", func(ctx context.Context, node composer.Node) error {
			_, err := registry.Parser(r, netconfig.PacketDialerKind)(ctx, node)
			return err
		}, "$type: direct"},
		{"packet listener fallback", func(ctx context.Context, node composer.Node) error {
			_, err := registry.Parser(r, netconfig.PacketListenerKind)(ctx, node)
			return err
		}, ""},
		{"stream endpoint named", func(ctx context.Context, node composer.Node) error {
			_, err := registry.Parser(r, netconfig.StreamEndpointKind)(ctx, node)
			return err
		}, "$type: dial\naddress: example.com:443"},
		{"packet endpoint fallback", func(ctx context.Context, node composer.Node) error {
			_, err := registry.Parser(r, netconfig.PacketEndpointKind)(ctx, node)
			return err
		}, "example.com:53"},
		{"transport named", func(ctx context.Context, node composer.Node) error {
			_, err := registry.Parser(r, TransportPairKind)(ctx, node)
			return err
		}, "$type: basic-access"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.parse(context.Background(), parseNode(t, test.yaml))
			require.ErrorIs(t, err, ErrMetadataWiring)
		})
	}
}

func TestMetadata_RepeatedParserOptionsStayIsolated(t *testing.T) {
	r := registry.New()
	directInfo := func(context.Context, *netconfig.DirectStreamDialerConfig) (ConnectionProviderInfo, error) {
		return ConnectionProviderInfo{ConnType: ConnTypeDirect}, nil
	}
	require.NoError(t, registry.Register(r, netconfig.StreamDialerKind, "direct",
		streamDialerParser(netconfig.NewDirectStreamDialerParser(&transport.TCPDialer{}), directInfo)))
	require.NoError(t, registry.RegisterFallback(r, netconfig.StreamDialerKind,
		streamDialerParser(
			func(context.Context, composer.Node) (*netconfig.DirectStreamDialerConfig, error) {
				return netconfig.NewDirectStreamDialerConfig(&transport.TCPDialer{}), nil
			},
			directInfo)))
	require.NoError(t, registry.RegisterFallback(r, netconfig.StreamEndpointKind,
		streamEndpointParser(
			netconfig.NewStreamDialEndpointParser(registry.Parser(r, netconfig.StreamDialerKind)),
			streamDialEndpointInfo)))
	for name, header := range map[registry.TypeName]string{"socket-a": "a", "socket-b": "b"} {
		require.NoError(t, registry.Register(r, netconfig.StreamEndpointKind, name,
			streamEndpointParser(
				netconfig.NewWebsocketEndpointParser(
					registry.Parser(r, netconfig.StreamEndpointKind),
					netconfig.WithWebsocketHeaders(http.Header{"X-App": []string{header}})),
				websocketInfo)))
	}
	ctx := WithMetadataCollection(context.Background())
	parse := registry.Parser(r, netconfig.StreamEndpointKind)
	a, err := parse(ctx, parseNode(t, "$type: socket-a\nurl: wss://example.com/a"))
	require.NoError(t, err)
	b, err := parse(ctx, parseNode(t, "$type: socket-b\nurl: wss://example.com/b"))
	require.NoError(t, err)
	require.Equal(t, "a", a.(*netconfig.WebsocketEndpointConfig).Headers.Get("X-App"))
	require.Equal(t, "b", b.(*netconfig.WebsocketEndpointConfig).Headers.Get("X-App"))

	a.(*netconfig.WebsocketEndpointConfig).Headers.Set("X-App", "changed")
	require.Equal(t, "b", b.(*netconfig.WebsocketEndpointConfig).Headers.Get("X-App"))
}

func TestMetadata_MissingCollectorSentinel(t *testing.T) {
	err := storeConnectionInfo(context.Background(), &netconfig.BlockConfig{}, ConnectionProviderInfo{})
	require.True(t, errors.Is(err, ErrMetadataWiring))
}
