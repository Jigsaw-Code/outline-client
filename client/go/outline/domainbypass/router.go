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

package domainbypass

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.getoutline.org/sdk/network/packetrelay"
	"golang.getoutline.org/sdk/transport"
	"golang.org/x/net/dns/dnsmessage"
)

var syntheticRange = netip.MustParsePrefix("198.18.0.0/16")
var dnsAddress = netip.MustParseAddrPort("169.254.113.53:53")

// Router has immutable rules for one tunnel session. Connections are owned by
// the network stack, and all DNS work has bounded time and memory.
type Router struct {
	fallback transport.StreamDialer
	relay    packetrelay.PacketRelay
	direct   transport.StreamDialer
	udp      *net.Dialer
	domains  map[string]netip.Addr
	hosts    map[netip.Addr]string
	active   map[string]bool
	dnsSlots chan struct{}
}

func New(c Config, fallback transport.StreamDialer, relay packetrelay.PacketRelay, direct transport.StreamDialer, udp *net.Dialer) *Router {
	r := &Router{fallback: fallback, relay: relay, direct: direct, udp: udp,
		domains: map[string]netip.Addr{}, hosts: map[netip.Addr]string{}, active: map[string]bool{}, dnsSlots: make(chan struct{}, 64)}
	for i, d := range c.KnownDomains {
		slot := i + 1
		ip := netip.AddrFrom4([4]byte{198, 18, byte(slot >> 8), byte(slot)})
		r.domains[d], r.hosts[ip] = ip, d
	}
	for _, d := range c.Domains {
		r.active[d] = true
	}
	return r
}

func (r *Router) DialStream(ctx context.Context, address string) (transport.StreamConn, error) {
	dst, err := netip.ParseAddrPort(address)
	if err != nil {
		return r.fallback.DialStream(ctx, address)
	}
	dst = netip.AddrPortFrom(dst.Addr().Unmap(), dst.Port())
	if dst == dnsAddress {
		select {
		case r.dnsSlots <- struct{}{}:
		default:
			return nil, errors.New("too many DNS connections")
		}
		client, server := net.Pipe()
		go func() {
			defer func() { <-r.dnsSlots }()
			defer server.Close()
			r.serveDNS(context.Background(), server)
		}()
		return &dnsStream{client}, nil
	}
	if syntheticRange.Contains(dst.Addr()) {
		host, ok := r.hosts[dst.Addr()]
		if !ok {
			return nil, errors.New("unknown synthetic address")
		}
		address = net.JoinHostPort(host, strconv.Itoa(int(dst.Port())))
		if r.active[host] {
			return r.direct.DialStream(ctx, address)
		}
		// A removed rule may still have cached DNS answers. Route it through the
		// server rather than retaining its old direct-connection permission.
		return r.fallback.DialStream(ctx, address)
	}
	return r.fallback.DialStream(ctx, address)
}

// dnsResponse returns nil for queries that should use the existing VPN resolver.
func (r *Router) dnsResponse(query []byte) ([]byte, error) {
	var q dnsmessage.Message
	if err := q.Unpack(query); err != nil {
		return nil, err
	}
	if q.Response || q.OpCode != 0 || len(q.Questions) != 1 {
		return nil, errors.New("invalid DNS query")
	}
	question := q.Questions[0]
	domain := strings.ToLower(strings.TrimSuffix(question.Name.String(), "."))
	if !r.active[domain] || question.Class != dnsmessage.ClassINET {
		return nil, nil
	}
	switch question.Type {
	case dnsmessage.TypeA, dnsmessage.TypeAAAA, dnsmessage.Type(64), dnsmessage.Type(65):
	default:
		// Preserve non-address records (TXT, MX, etc.) through the VPN resolver.
		return nil, nil
	}
	response := dnsmessage.Message{Header: dnsmessage.Header{ID: q.ID, Response: true,
		RecursionDesired: q.RecursionDesired, RecursionAvailable: true}, Questions: q.Questions}
	if question.Type == dnsmessage.TypeA {
		response.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: question.Name,
			Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 1}, Body: &dnsmessage.AResource{A: r.domains[domain].As4()}}}
	}
	// AAAA and HTTPS/SVCB return NODATA so IPv6/HTTPS address hints cannot skip
	// the synthetic route. The actual direct connection can still use IPv6.
	return response.Pack()
}

func (r *Router) serveDNS(ctx context.Context, conn net.Conn) {
	var length [2]byte
	for {
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return
		}
		size := int(binary.BigEndian.Uint16(length[:]))
		if size < 12 || size > 4096 {
			return
		}
		query := make([]byte, size)
		if _, err := io.ReadFull(conn, query); err != nil {
			return
		}
		response, err := r.dnsResponse(query)
		if err != nil {
			return
		}
		if response == nil {
			response, err = r.forwardDNS(ctx, query)
			if err != nil {
				return
			}
		}
		binary.BigEndian.PutUint16(length[:], uint16(len(response)))
		if _, err := conn.Write(append(length[:], response...)); err != nil {
			return
		}
	}
}

func (r *Router) forwardDNS(ctx context.Context, query []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	upstream, err := r.fallback.DialStream(ctx, dnsAddress.String())
	if err != nil {
		return nil, err
	}
	defer upstream.Close()
	_ = upstream.SetDeadline(time.Now().Add(10 * time.Second))
	var length [2]byte
	binary.BigEndian.PutUint16(length[:], uint16(len(query)))
	if _, err = upstream.Write(append(length[:], query...)); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(upstream, length[:]); err != nil {
		return nil, err
	}
	response := make([]byte, int(binary.BigEndian.Uint16(length[:])))
	_, err = io.ReadFull(upstream, response)
	return response, err
}

type dnsStream struct{ net.Conn }

func (c *dnsStream) CloseRead() error  { return c.Close() }
func (c *dnsStream) CloseWrite() error { return c.Close() }
