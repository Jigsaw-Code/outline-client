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

package netconfig

import (
	"context"

	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
)

// DirectStreamDialerConfig wraps a base dialer captured at registry
// construction.
type DirectStreamDialerConfig struct {
	dialer transport.StreamDialer
}

func NewDirectStreamDialerConfig(d transport.StreamDialer) *DirectStreamDialerConfig {
	return &DirectStreamDialerConfig{dialer: d}
}

// NewDirectStreamDialerParser returns a parser for a direct stream dialer
// backed by d.
func NewDirectStreamDialerParser(d transport.StreamDialer) composer.ParseFunc[*DirectStreamDialerConfig] {
	cfg := NewDirectStreamDialerConfig(d)
	return constantConfigParser(cfg)
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

// NewDirectPacketDialerParser returns a parser for a direct packet dialer
// backed by d.
func NewDirectPacketDialerParser(d transport.PacketDialer) composer.ParseFunc[*DirectPacketDialerConfig] {
	cfg := NewDirectPacketDialerConfig(d)
	return constantConfigParser(cfg)
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

// NewDirectPacketListenerParser returns a parser for a direct packet listener
// backed by l.
func NewDirectPacketListenerParser(l transport.PacketListener) composer.ParseFunc[*DirectPacketListenerConfig] {
	cfg := NewDirectPacketListenerConfig(l)
	return constantConfigParser(cfg)
}

func (c *DirectPacketListenerConfig) NewPacketListener(ctx context.Context) (transport.PacketListener, error) {
	return c.listener, nil
}

func constantConfigParser[Cfg any](cfg Cfg) composer.ParseFunc[Cfg] {
	return func(_ context.Context, node composer.Node) (Cfg, error) {
		var fields struct{}
		if err := node.Decode(&fields); err != nil {
			var zero Cfg
			return zero, err
		}
		return cfg, nil
	}
}
