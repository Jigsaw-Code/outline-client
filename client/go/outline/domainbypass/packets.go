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
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"golang.getoutline.org/sdk/network/packetrelay"
)

type packet struct {
	data   []byte
	source netip.AddrPort
}

type association struct {
	router    *Router
	mu        sync.Mutex
	closed    bool
	fallback  packetrelay.PacketSender
	direct    map[netip.AddrPort]net.Conn
	responses chan packet
	done      chan struct{}
	ctx       context.Context
	cancel    context.CancelFunc
}

func (r *Router) NewAssociation() (packetrelay.PacketSender, packetrelay.PacketReceiver, error) {
	ctx, cancel := context.WithCancel(context.Background())
	a := &association{router: r, direct: map[netip.AddrPort]net.Conn{}, responses: make(chan packet, 16), done: make(chan struct{}), ctx: ctx, cancel: cancel}
	return a, a, nil
}

func (a *association) Close() error {
	a.cancel()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return packetrelay.ErrClosed
	}
	a.closed = true
	close(a.done)
	if a.fallback != nil {
		_ = a.fallback.Close()
	}
	for _, conn := range a.direct {
		_ = conn.Close()
	}
	return nil
}

func (a *association) HandlePacket(p []byte, source netip.AddrPort) error {
	select {
	case <-a.done:
		return packetrelay.ErrClosed
	default:
	}
	item := packet{append([]byte(nil), p...), source}
	select {
	case <-a.done:
		return packetrelay.ErrClosed
	case a.responses <- item:
		return nil
	default:
		return errors.New("packet response queue full")
	}
}

func (a *association) ReceivePackets(handler packetrelay.PacketHandler) error {
	defer a.Close()
	for {
		select {
		case <-a.done:
			return nil
		case p := <-a.responses:
			if err := handler.HandlePacket(p.data, p.source); err != nil {
				return err
			}
		}
	}
}

func (a *association) SendPacket(p []byte, destination netip.AddrPort) error {
	destination = netip.AddrPortFrom(destination.Addr().Unmap(), destination.Port())
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return packetrelay.ErrClosed
	}
	if destination == dnsAddress {
		answer, err := a.router.dnsResponse(p)
		if err != nil {
			return err
		}
		if answer != nil {
			return a.HandlePacket(answer, destination)
		}
	}
	if syntheticRange.Contains(destination.Addr()) {
		host, ok := a.router.hosts[destination.Addr()]
		if !ok || !a.router.active[host] {
			// An expired exclusion must never retain permission to send direct UDP.
			// Drop cached UDP flows; the next DNS lookup will use the normal VPN route.
			return errors.New("inactive synthetic UDP destination")
		}
		conn := a.direct[destination]
		if conn == nil {
			if len(a.direct) >= 16 {
				return errors.New("too many direct UDP destinations")
			}
			ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
			var err error
			conn, err = a.router.udp.DialContext(ctx, "udp", net.JoinHostPort(host, strconv.Itoa(int(destination.Port()))))
			cancel()
			if err != nil {
				return err
			}
			a.direct[destination] = conn
			go a.receiveDirect(conn, destination)
		}
		_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
		_, err := conn.Write(p)
		return err
	}
	if a.fallback == nil {
		sender, receiver, err := a.router.relay.NewAssociation()
		if err != nil {
			return err
		}
		a.fallback = sender
		go func() { _ = receiver.ReceivePackets(a); _ = a.Close() }()
	}
	return a.fallback.SendPacket(p, destination)
}

func (a *association) receiveDirect(conn net.Conn, source netip.AddrPort) {
	defer a.Close()
	buffer := make([]byte, 65535)
	for {
		n, err := conn.Read(buffer)
		if err != nil {
			return
		}
		if err = a.HandlePacket(buffer[:n], source); err != nil {
			return
		}
	}
}
