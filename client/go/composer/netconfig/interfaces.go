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
	"localhost/client/go/composer/registry"
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

// Kinds are the typed Composer extension points owned by the networking
// contracts. Applications register concrete parsers directly under these
// shared identities.
var (
	StreamDialerKind   = registry.NewKind[StreamDialerConfig]("stream dialer")
	PacketDialerKind   = registry.NewKind[PacketDialerConfig]("packet dialer")
	StreamEndpointKind = registry.NewKind[StreamEndpointConfig]("stream endpoint")
	PacketEndpointKind = registry.NewKind[PacketEndpointConfig]("packet endpoint")
	PacketListenerKind = registry.NewKind[PacketListenerConfig]("packet listener")
)
