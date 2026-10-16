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
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/netip"
	"time"

	"golang.getoutline.org/sdk/network/dnsintercept"
	"golang.getoutline.org/sdk/network/dnstruncate"
	"golang.getoutline.org/sdk/network/packetrelay"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/outline/connectivity"
)

// Public DNS resolvers available to an Outline VPN session.
var outlineDNSResolvers = []netip.AddrPort{
	netip.MustParseAddrPort("1.1.1.1:53"),
	netip.MustParseAddrPort("9.9.9.9:53"),
	netip.MustParseAddrPort("208.67.222.222:53"),
	netip.MustParseAddrPort("208.67.220.220:53"),
}

// linkLocalDNS is the synthetic resolver address configured by the platform
// VPN implementations. Keep it in sync with those configurations.
//
// TODO: make this configurable via VpnConfig.
var linkLocalDNS = netip.MustParseAddrPort("169.254.113.53:53")

// NewOutlineDNSTransport applies Outline's TCP and UDP DNS interception policy
// to a built transport. UDP DNS starts in truncate mode, forcing the system to
// retry over TCP until UDP connectivity has been verified.
func NewOutlineDNSTransport(sd transport.StreamDialer, pl transport.PacketListener) (transport.StreamDialer, packetrelay.PacketRelay, func(), error) {
	remoteDNS := outlineDNSResolvers[rand.IntN(len(outlineDNSResolvers))]

	sdForward := func(ctx context.Context, addr string) (transport.StreamConn, error) {
		if dst, err := netip.ParseAddrPort(addr); err == nil && dst.Addr().Unmap() == linkLocalDNS.Addr() && dst.Port() == linkLocalDNS.Port() {
			addr = remoteDNS.String()
		}
		return sd.DialStream(ctx, addr)
	}

	baseListener, err := packetrelay.NewPacketRelayFromPacketListener(pl, 30*time.Second)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to create base PacketRelay: %w", err)
	}
	// DNS uses a shorter timeout on an independent listener so its forwarding
	// policy does not affect non-DNS packet relay state.
	dnsListener, err := packetrelay.NewPacketRelayFromPacketListener(pl, 5*time.Second)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to create DNS PacketRelay: %w", err)
	}
	relayForward := dnsintercept.NewInterceptDNSPacketRelay(dnsListener, baseListener, linkLocalDNS, remoteDNS)
	// Truncated responses force resolvers to retry over TCP. Non-DNS traffic
	// continues through baseListener.
	dnsTruncRelay, err := dnstruncate.NewPacketRelay()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to create DNS truncate relay: %w", err)
	}
	relayTrunc := dnsintercept.NewInterceptDNSPacketRelay(dnsTruncRelay, baseListener, linkLocalDNS, remoteDNS)
	// UDP has not been verified yet, so start with the conservative TCP-retry
	// behavior and switch to forwarding only after a successful health check.
	relayMain, err := packetrelay.NewDelegatePacketRelay(relayTrunc)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to create delegate PacketRelay: %w", err)
	}

	onNetworkChanged := func() {
		go func() {
			if err := connectivity.CheckUDPConnectivity(pl); err == nil {
				slog.Info("remote device UDP is healthy")
				relayMain.SetRelay(relayForward)
			} else {
				slog.Warn("remote device UDP is not healthy", "err", err)
				relayMain.SetRelay(relayTrunc)
			}
		}()
	}

	return transport.FuncStreamDialer(sdForward), relayMain, onNetworkChanged, nil
}
