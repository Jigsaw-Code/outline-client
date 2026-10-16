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
	"testing"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
)

func TestDirectParserConstructors(t *testing.T) {
	stream := &transport.TCPDialer{}
	packet := &transport.UDPDialer{}
	listener := &transport.UDPListener{}

	streamCfg, err := NewDirectStreamDialerParser(stream)(context.Background(), mustNode(t, "$type: direct"))
	require.NoError(t, err)
	builtStream, err := streamCfg.NewStreamDialer(context.Background())
	require.NoError(t, err)
	require.Same(t, stream, builtStream)

	packetCfg, err := NewDirectPacketDialerParser(packet)(context.Background(), mustNode(t, "$type: direct"))
	require.NoError(t, err)
	builtPacket, err := packetCfg.NewPacketDialer(context.Background())
	require.NoError(t, err)
	require.Same(t, packet, builtPacket)

	listenerCfg, err := NewDirectPacketListenerParser(listener)(context.Background(), mustNode(t, "$type: direct"))
	require.NoError(t, err)
	builtListener, err := listenerCfg.NewPacketListener(context.Background())
	require.NoError(t, err)
	require.Same(t, listener, builtListener)
}

func TestDirectParserRejectsFields(t *testing.T) {
	_, err := NewDirectStreamDialerParser(&transport.TCPDialer{})(
		context.Background(), mustNode(t, "$type: direct\nunexpected: true"))
	require.Error(t, err)
}
