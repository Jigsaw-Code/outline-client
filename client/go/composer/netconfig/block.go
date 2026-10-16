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
	"errors"
	"net"

	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
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
