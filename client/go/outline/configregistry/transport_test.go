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
	"localhost/client/go/composer/netconfig"
	"localhost/client/go/composer/registry"
)

func parseTransport(t *testing.T, text string) TransportPairConfig {
	t.Helper()
	cfg, _ := parseTransportWithInfo(t, text)
	return cfg
}

func parseTransportWithInfo(t *testing.T, text string) (TransportPairConfig, TransportPairInfo) {
	t.Helper()
	r := registry.New()
	require.NoError(t, Register(r, &transport.TCPDialer{}, &transport.UDPDialer{}))
	parse := registry.Parser(r, TransportPairKind)
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	ctx := WithMetadataCollection(context.Background())
	cfg, err := parse(ctx, node)
	require.NoError(t, err)
	info, err := TransportMetadata(ctx, cfg)
	require.NoError(t, err)
	return cfg, info
}

func TestTransport_LegacySSURL(t *testing.T) {
	cfg, info := parseTransportWithInfo(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`)
	require.Equal(t, ConnTypeTunneled, info.Stream.ConnType)
	require.Equal(t, "example.com:1234", info.Stream.FirstHop)
	require.Equal(t, ConnTypeTunneled, info.Packet.ConnType)

	parts, err := cfg.NewTransportPair(context.Background())
	require.NoError(t, err)
	require.NotNil(t, parts.StreamDialer)
	require.NotNil(t, parts.PacketListener)
}

func TestTransport_LegacyMappingNoType(t *testing.T) {
	_, info := parseTransportWithInfo(t, `
server: example.com
server_port: 1234
method: chacha20-ietf-poly1305
password: SECRET
`)
	require.Equal(t, "example.com:1234", info.Stream.FirstHop)
}

func TestTransport_TCPUDP(t *testing.T) {
	_, info := parseTransportWithInfo(t, `
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
	require.Equal(t, "example.com:1234", info.Stream.FirstHop)
	require.Equal(t, "example.com:5678", info.Packet.FirstHop)
}

func TestTransport_TCPUDP_DefaultsToDirect(t *testing.T) {
	_, info := parseTransportWithInfo(t, "$type: tcpudp")
	require.Equal(t, ConnTypeDirect, info.Stream.ConnType)
	require.Equal(t, ConnTypeDirect, info.Packet.ConnType)
}

func TestTransport_BasicAccess(t *testing.T) {
	cfg, info := parseTransportWithInfo(t, "$type: basic-access")
	require.Equal(t, ConnTypeDirect, info.Stream.ConnType)
	parts, err := cfg.NewTransportPair(context.Background())
	require.NoError(t, err)
	require.NotNil(t, parts.StreamDialer)
}

// TestTransport_ShadowsocksPrefixTCPOnly verifies the legacy behavior that,
// in the Shadowsocks transport form (scalar ss:// URL or mapping without
// $type), a `prefix` applies only to TCP: the packet listener's salt
// generator must NOT be set, even though the stream dialer's is.
func TestTransport_ShadowsocksPrefixTCPOnly_URL(t *testing.T) {
	cfg := parseTransport(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234?prefix=POST%20"`)
	ssCfg, ok := cfg.(*ShadowsocksTransportConfig)
	require.True(t, ok, "expected *ShadowsocksTransportConfig, got %T", cfg)
	require.NotNil(t, ssCfg.StreamDialer.SaltGenerator, "prefix must apply to TCP")
	require.Nil(t, ssCfg.PacketListener.SaltGenerator, "prefix must not apply to UDP in the transport form")
}

func TestTransport_ShadowsocksPrefixTCPOnly_Mapping(t *testing.T) {
	cfg := parseTransport(t, `
endpoint: example.com:1234
cipher: chacha20-ietf-poly1305
secret: SECRET
prefix: "POST "
`)
	ssCfg, ok := cfg.(*ShadowsocksTransportConfig)
	require.True(t, ok, "expected *ShadowsocksTransportConfig, got %T", cfg)
	require.NotNil(t, ssCfg.StreamDialer.SaltGenerator, "prefix must apply to TCP")
	require.Nil(t, ssCfg.PacketListener.SaltGenerator, "prefix must not apply to UDP in the transport form")
}

// TestTransport_ShadowsocksPrefixExplicitPacketListener verifies that an
// explicit `$type: shadowsocks` packet-listener config (as used within a
// tcpudp config) still honors `prefix`, per the legacy comment: "To use a
// prefix with UDP, one needs to specify it in the PacketListener config
// explicitly."
func TestTransport_ShadowsocksPrefixExplicitPacketListener(t *testing.T) {
	cfg := parseTransport(t, `
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
  prefix: "POST "
`)
	tcpudpCfg, ok := cfg.(*TCPUDPTransportConfig)
	require.True(t, ok, "expected *TCPUDPTransportConfig, got %T", cfg)
	plCfg, ok := tcpudpCfg.UDP.(*netconfig.ShadowsocksPacketListenerConfig)
	require.True(t, ok, "expected *netconfig.ShadowsocksPacketListenerConfig, got %T", tcpudpCfg.UDP)
	require.NotNil(t, plCfg.SaltGenerator, "explicit packet-listener prefix must be honored")
}

func TestTransport_FirstSupported(t *testing.T) {
	_, info := parseTransportWithInfo(t, `
$type: first-supported
options:
  - $type: warp-drive
  - $type: tcpudp
`)
	require.Equal(t, ConnTypeDirect, info.Stream.ConnType)
}
