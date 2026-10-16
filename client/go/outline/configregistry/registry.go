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

// Package configregistry owns Outline's Composer registration, compatibility
// behavior, connection metadata, and transport policy.
package configregistry

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"testing"

	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
	"localhost/client/go/composer/netconfig"
	"localhost/client/go/composer/registry"
	"localhost/client/go/outline/useragent"
)

// Register installs Outline's config vocabulary and compatibility fallbacks.
func Register(r registry.Registrar, directSD transport.StreamDialer, directPD transport.PacketDialer) error {
	directStream := netconfig.NewDirectStreamDialerConfig(directSD)
	directPacket := netconfig.NewDirectPacketDialerConfig(directPD)
	directListener := netconfig.NewDirectPacketListenerConfig(&transport.UDPListener{})
	directInfo := ConnectionProviderInfo{ConnType: ConnTypeDirect}

	// Named registrations, sorted by their $type value.
	if err := registry.Register(r, TransportPairKind, "basic-access",
		transportPairParser(parseBasicAccess,
			func(context.Context, *BasicAccessTransportConfig) (TransportPairInfo, error) {
				return TransportPairInfo{Stream: directInfo, Packet: directInfo}, nil
			})); err != nil {
		return fmt.Errorf("register basic-access: %w", err)
	}
	if err := registry.Register(r, netconfig.StreamDialerKind, "block",
		streamDialerParser(netconfig.ParseBlock,
			func(context.Context, *netconfig.BlockConfig) (ConnectionProviderInfo, error) {
				return ConnectionProviderInfo{ConnType: ConnTypeBlocked}, nil
			})); err != nil {
		return fmt.Errorf("register block stream dialer: %w", err)
	}
	if err := registry.Register(r, netconfig.PacketDialerKind, "block",
		packetDialerParser(netconfig.ParseBlock,
			func(context.Context, *netconfig.BlockConfig) (ConnectionProviderInfo, error) {
				return ConnectionProviderInfo{ConnType: ConnTypeBlocked}, nil
			})); err != nil {
		return fmt.Errorf("register block packet dialer: %w", err)
	}
	if err := registry.Register(r, netconfig.StreamEndpointKind, "dial",
		streamEndpointParser(
			netconfig.NewStreamDialEndpointParser(registry.Parser(r, netconfig.StreamDialerKind)),
			streamDialEndpointInfo)); err != nil {
		return fmt.Errorf("register dial stream endpoint: %w", err)
	}
	if err := registry.Register(r, netconfig.PacketEndpointKind, "dial",
		packetEndpointParser(
			netconfig.NewPacketDialEndpointParser(registry.Parser(r, netconfig.PacketDialerKind)),
			packetDialEndpointInfo)); err != nil {
		return fmt.Errorf("register dial packet endpoint: %w", err)
	}
	if err := registry.Register(r, netconfig.StreamDialerKind, "direct",
		streamDialerParser(netconfig.NewDirectStreamDialerParser(directSD),
			func(context.Context, *netconfig.DirectStreamDialerConfig) (ConnectionProviderInfo, error) {
				return directInfo, nil
			})); err != nil {
		return fmt.Errorf("register direct stream dialer: %w", err)
	}
	if err := registry.Register(r, netconfig.PacketDialerKind, "direct",
		packetDialerParser(netconfig.NewDirectPacketDialerParser(directPD),
			func(context.Context, *netconfig.DirectPacketDialerConfig) (ConnectionProviderInfo, error) {
				return directInfo, nil
			})); err != nil {
		return fmt.Errorf("register direct packet dialer: %w", err)
	}
	if err := registry.Register(r, netconfig.PacketListenerKind, "direct",
		packetListenerParser(netconfig.NewDirectPacketListenerParser(&transport.UDPListener{}),
			func(context.Context, *netconfig.DirectPacketListenerConfig) (ConnectionProviderInfo, error) {
				return directInfo, nil
			})); err != nil {
		return fmt.Errorf("register direct packet listener: %w", err)
	}
	if err := registry.Register(r, netconfig.StreamDialerKind, "iptable",
		streamDialerParser(newIPTableParser(registry.Parser(r, netconfig.StreamDialerKind)), ipTableInfo)); err != nil {
		return fmt.Errorf("register iptable stream dialer: %w", err)
	}
	if err := registry.Register(r, netconfig.StreamDialerKind, "shadowsocks",
		streamDialerParser(
			netconfig.NewShadowsocksStreamDialerParser(registry.Parser(r, netconfig.StreamEndpointKind)),
			shadowsocksStreamInfo)); err != nil {
		return fmt.Errorf("register Shadowsocks stream dialer: %w", err)
	}
	if err := registry.Register(r, netconfig.PacketDialerKind, "shadowsocks",
		packetDialerParser(
			netconfig.NewShadowsocksPacketDialerParser(registry.Parser(r, netconfig.PacketEndpointKind)),
			shadowsocksPacketDialerInfo)); err != nil {
		return fmt.Errorf("register Shadowsocks packet dialer: %w", err)
	}
	if err := registry.Register(r, netconfig.PacketListenerKind, "shadowsocks",
		packetListenerParser(
			netconfig.NewShadowsocksPacketListenerParser(registry.Parser(r, netconfig.PacketEndpointKind)),
			shadowsocksPacketListenerInfo)); err != nil {
		return fmt.Errorf("register Shadowsocks packet listener: %w", err)
	}
	if err := registry.Register(r, TransportPairKind, "tcpudp",
		transportPairParser(
			newTCPUDPParser(
				registry.Parser(r, netconfig.StreamDialerKind),
				registry.Parser(r, netconfig.PacketListenerKind)),
			tcpudpInfo)); err != nil {
		return fmt.Errorf("register tcpudp transport: %w", err)
	}
	headers := http.Header{"User-Agent": []string{useragent.GetOutlineUserAgent()}}
	if err := registry.Register(r, netconfig.StreamEndpointKind, "websocket",
		streamEndpointParser(
			netconfig.NewWebsocketEndpointParser(
				registry.Parser(r, netconfig.StreamEndpointKind),
				netconfig.WithWebsocketHeaders(headers)),
			websocketInfo)); err != nil {
		return fmt.Errorf("register WebSocket stream endpoint: %w", err)
	}
	if err := registry.Register(r, netconfig.PacketEndpointKind, "websocket",
		packetEndpointParser(
			netconfig.NewWebsocketEndpointParser(
				registry.Parser(r, netconfig.StreamEndpointKind),
				netconfig.WithWebsocketHeaders(headers)),
			websocketInfo)); err != nil {
		return fmt.Errorf("register WebSocket packet endpoint: %w", err)
	}

	// Unnamed compatibility fallbacks.
	if err := registry.RegisterFallback(r, netconfig.StreamEndpointKind,
		streamEndpointParser(
			netconfig.NewStreamDialEndpointParser(registry.Parser(r, netconfig.StreamDialerKind)),
			streamDialEndpointInfo)); err != nil {
		return fmt.Errorf("register stream endpoint fallback: %w", err)
	}
	if err := registry.RegisterFallback(r, netconfig.PacketEndpointKind,
		packetEndpointParser(
			netconfig.NewPacketDialEndpointParser(registry.Parser(r, netconfig.PacketDialerKind)),
			packetDialEndpointInfo)); err != nil {
		return fmt.Errorf("register packet endpoint fallback: %w", err)
	}
	parseDirectStream := streamDialerParser(
		func(_ context.Context, node composer.Node) (*netconfig.DirectStreamDialerConfig, error) {
			if !node.IsAbsent() {
				return nil, errors.New("parser not specified")
			}
			return directStream, nil
		},
		func(context.Context, *netconfig.DirectStreamDialerConfig) (ConnectionProviderInfo, error) {
			return directInfo, nil
		})
	parseShadowsocksStream := streamDialerParser(
		netconfig.NewShadowsocksStreamDialerParser(registry.Parser(r, netconfig.StreamEndpointKind)),
		shadowsocksStreamInfo)
	if err := registry.RegisterFallback(r, netconfig.StreamDialerKind,
		func(ctx context.Context, node composer.Node) (netconfig.StreamDialerConfig, error) {
			switch node.Kind() {
			case composer.KindAbsent:
				return parseDirectStream(ctx, node)
			case composer.KindScalar:
				return parseShadowsocksStream(ctx, node)
			default:
				return nil, errors.New("parser not specified")
			}
		}); err != nil {
		return fmt.Errorf("register stream dialer fallback: %w", err)
	}
	parseDirectPacket := packetDialerParser(
		func(_ context.Context, node composer.Node) (*netconfig.DirectPacketDialerConfig, error) {
			if !node.IsAbsent() {
				return nil, errors.New("parser not specified")
			}
			return directPacket, nil
		},
		func(context.Context, *netconfig.DirectPacketDialerConfig) (ConnectionProviderInfo, error) {
			return directInfo, nil
		})
	parseShadowsocksPacket := packetDialerParser(
		netconfig.NewShadowsocksPacketDialerParser(registry.Parser(r, netconfig.PacketEndpointKind)),
		shadowsocksPacketDialerInfo)
	if err := registry.RegisterFallback(r, netconfig.PacketDialerKind,
		func(ctx context.Context, node composer.Node) (netconfig.PacketDialerConfig, error) {
			switch node.Kind() {
			case composer.KindAbsent:
				return parseDirectPacket(ctx, node)
			case composer.KindScalar:
				return parseShadowsocksPacket(ctx, node)
			default:
				return nil, errors.New("parser not specified")
			}
		}); err != nil {
		return fmt.Errorf("register packet dialer fallback: %w", err)
	}
	if err := registry.RegisterFallback(r, netconfig.PacketListenerKind,
		packetListenerParser(
			func(_ context.Context, node composer.Node) (*netconfig.DirectPacketListenerConfig, error) {
				if !node.IsAbsent() {
					return nil, errors.New("parser not specified")
				}
				return directListener, nil
			},
			func(context.Context, *netconfig.DirectPacketListenerConfig) (ConnectionProviderInfo, error) {
				return directInfo, nil
			})); err != nil {
		return fmt.Errorf("register packet listener fallback: %w", err)
	}
	if err := registry.RegisterFallback(r, TransportPairKind,
		transportPairParser(
			newLegacyShadowsocksTransportParser(
				netconfig.NewShadowsocksStreamDialerParser(registry.Parser(r, netconfig.StreamEndpointKind)),
				netconfig.NewShadowsocksPacketListenerParser(registry.Parser(r, netconfig.PacketEndpointKind))),
			legacyShadowsocksTransportInfo)); err != nil {
		return fmt.Errorf("register legacy shadowsocks: %w", err)
	}
	return nil
}

func streamDialEndpointInfo(ctx context.Context, cfg *netconfig.StreamDialEndpointConfig) (ConnectionProviderInfo, error) {
	info, err := requireConnectionInfo(ctx, cfg.Dialer)
	if err != nil {
		return ConnectionProviderInfo{}, err
	}
	if info.ConnType == ConnTypeDirect {
		// Rewrite to the resolved form so FirstHop is the address the runtime
		// dials and a platform bypass route can cover it exactly. A no-op when
		// this platform does not resolve; re-resolving an IP is a no-op too.
		cfg.Address = resolveDirectFirstHop(ctx, cfg.Address)
		info.FirstHop = cfg.Address
	}
	return info, nil
}

func packetDialEndpointInfo(ctx context.Context, cfg *netconfig.PacketDialEndpointConfig) (ConnectionProviderInfo, error) {
	info, err := requireConnectionInfo(ctx, cfg.Dialer)
	if err != nil {
		return ConnectionProviderInfo{}, err
	}
	if info.ConnType == ConnTypeDirect {
		cfg.Address = resolveDirectFirstHop(ctx, cfg.Address)
		info.FirstHop = cfg.Address
	}
	return info, nil
}

type directResolutionKey struct{}

// directResolution memoizes direct-endpoint resolution for one parse, so a
// transport's stream and packet halves resolve a shared host to the same
// address. Without it their first hops could differ and be dropped. It is
// specific to the direct-dialing logic and deliberately separate from the
// metadata collector.
type directResolution struct {
	resolved map[string]string
}

// WithDirectDialResolution seeds the per-parse direct-resolution cache into ctx.
// ParseConfig adds it to the parse context alongside the metadata collector.
func WithDirectDialResolution(ctx context.Context) context.Context {
	return context.WithValue(ctx, directResolutionKey{}, &directResolution{resolved: map[string]string{}})
}

// resolveDirectFirstHop resolves a direct endpoint's address to the form the
// runtime will dial, memoized per parse via the cache in ctx. A missing cache
// (a parse context set up without WithDirectDialResolution) just skips
// memoization.
func resolveDirectFirstHop(ctx context.Context, address string) string {
	cache, _ := ctx.Value(directResolutionKey{}).(*directResolution)
	if cache != nil {
		if resolved, ok := cache.resolved[address]; ok {
			return resolved
		}
	}
	resolved := directAddressResolver(ctx, address)
	if cache != nil {
		cache.resolved[address] = resolved
	}
	return resolved
}

// directAddressResolver rewrites a direct endpoint's address to the one the
// runtime will dial. It is a package variable so tests can exercise resolution
// deterministically; production always uses platformDirectAddressResolver.
var directAddressResolver = platformDirectAddressResolver

// platformDirectAddressResolver resolves a direct endpoint's address to an IP on
// the platforms that require it, and returns it unchanged elsewhere.
//
// Direct first hops are resolved up front on Linux and Windows, for two
// different platform reasons:
//
//   - Windows: the routing daemon installs a bypass route for the first hop
//     (client/electron/index.ts passes it to RoutingDaemon as proxyIp, which
//     becomes a "<host>/32" routing table entry) so proxy traffic skips the
//     tunnel. The address we dial therefore has to be the one that route
//     covers.
//   - Linux: the VPN protects sockets with a FW_MARK, but the system
//     resolver's socket is not marked. Resolving at dial time would send the
//     DNS query into the tunnel, so we resolve while normal routing still
//     applies.
//
// Parsing runs before the tunnel routes are installed (ParseConfig precedes
// vpn.EstablishVPN), so this resolution happens while normal routing applies.
// The resolved address is written back to Address and reported as FirstHop, so
// the platform installs its bypass route for the very address we dial instead
// of resolving the hostname a second time and possibly getting a different one.
//
// A no-op under test so the suite does not depend on DNS, and on platforms that
// dial hostnames directly. Resolution failure is non-fatal: the hostname
// remains and the runtime dialer resolves it at dial time.
func platformDirectAddressResolver(ctx context.Context, address string) string {
	if (runtime.GOOS != "linux" && runtime.GOOS != "windows") || testing.Testing() {
		return address
	}
	resolved, err := resolveAddress(ctx, address)
	if err != nil {
		return address
	}
	return resolved
}

// resolveAddress resolves host:port to its ip:port form. It resolves the host
// without regard to transport, so a config's stream and packet halves cannot
// disagree about the server's address.
func resolveAddress(ctx context.Context, address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", err
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return "", err
	}
	if len(ips) == 0 {
		return "", fmt.Errorf("no addresses for %q", host)
	}
	return net.JoinHostPort(ips[0].Unmap().String(), port), nil
}

func websocketInfo(ctx context.Context, cfg *netconfig.WebsocketEndpointConfig) (ConnectionProviderInfo, error) {
	return requireConnectionInfo(ctx, cfg.Endpoint)
}

func shadowsocksStreamInfo(ctx context.Context, cfg *netconfig.ShadowsocksStreamDialerConfig) (ConnectionProviderInfo, error) {
	info, err := requireConnectionInfo(ctx, cfg.Endpoint)
	if err != nil {
		return ConnectionProviderInfo{}, err
	}
	return ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: info.FirstHop}, nil
}

func shadowsocksPacketListenerInfo(ctx context.Context, cfg *netconfig.ShadowsocksPacketListenerConfig) (ConnectionProviderInfo, error) {
	info, err := requireConnectionInfo(ctx, cfg.Endpoint)
	if err != nil {
		return ConnectionProviderInfo{}, err
	}
	return ConnectionProviderInfo{ConnType: ConnTypeTunneled, FirstHop: info.FirstHop}, nil
}

func shadowsocksPacketDialerInfo(ctx context.Context, cfg *netconfig.ShadowsocksPacketDialerConfig) (ConnectionProviderInfo, error) {
	info, err := shadowsocksPacketListenerInfo(ctx, cfg.Listener)
	if err != nil {
		return ConnectionProviderInfo{}, err
	}
	if err := storeConnectionInfo(ctx, cfg.Listener, info); err != nil {
		return ConnectionProviderInfo{}, err
	}
	return info, nil
}

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
	for i, entry := range cfg.Entries {
		info, err := requireConnectionInfo(ctx, entry.Dialer)
		if err != nil {
			return ConnectionProviderInfo{}, fmt.Errorf("iptable entry %d: %w", i, err)
		}
		consider(info)
	}
	if cfg.Fallback != nil {
		info, err := requireConnectionInfo(ctx, cfg.Fallback)
		if err != nil {
			return ConnectionProviderInfo{}, fmt.Errorf("iptable fallback: %w", err)
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

func tcpudpInfo(ctx context.Context, cfg *TCPUDPTransportConfig) (TransportPairInfo, error) {
	stream, err := requireConnectionInfo(ctx, cfg.TCP)
	if err != nil {
		return TransportPairInfo{}, fmt.Errorf("TCP transport: %w", err)
	}
	packet, err := requireConnectionInfo(ctx, cfg.UDP)
	if err != nil {
		return TransportPairInfo{}, fmt.Errorf("UDP transport: %w", err)
	}
	return TransportPairInfo{Stream: stream, Packet: packet}, nil
}

func legacyShadowsocksTransportInfo(ctx context.Context, cfg *ShadowsocksTransportConfig) (TransportPairInfo, error) {
	stream, err := shadowsocksStreamInfo(ctx, cfg.StreamDialer)
	if err != nil {
		return TransportPairInfo{}, fmt.Errorf("legacy Shadowsocks stream transport: %w", err)
	}
	if err := storeConnectionInfo(ctx, cfg.StreamDialer, stream); err != nil {
		return TransportPairInfo{}, err
	}
	packet, err := shadowsocksPacketListenerInfo(ctx, cfg.PacketListener)
	if err != nil {
		return TransportPairInfo{}, fmt.Errorf("legacy Shadowsocks packet transport: %w", err)
	}
	if err := storeConnectionInfo(ctx, cfg.PacketListener, packet); err != nil {
		return TransportPairInfo{}, err
	}
	return TransportPairInfo{Stream: stream, Packet: packet}, nil
}
