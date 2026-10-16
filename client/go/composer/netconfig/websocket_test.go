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
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
)

type fakeSE struct{}

func (fakeSE) NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error) {
	return transport.FuncStreamEndpoint(func(ctx context.Context) (transport.StreamConn, error) {
		return nil, nil
	}), nil
}

func parseSEForTest(t *testing.T, wantNode string) composer.ParseFunc[StreamEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (StreamEndpointConfig, error) {
		if wantNode != "" {
			var addr string
			require.NoError(t, node.Decode(&addr))
			require.Equal(t, wantNode, addr)
		}
		return &fakeSE{}, nil
	}
}

func TestWebsocket_ParseAndDefaults(t *testing.T) {
	// URL without endpoint: inner endpoint defaults to URL host:port.
	parse := NewWebsocketEndpointParser(parseSEForTest(t, "cdn.example.com:443"))
	cfg, err := parse(context.Background(), mustNode(t, "$type: websocket\nurl: https://cdn.example.com/tcp"))
	require.NoError(t, err)
	require.Equal(t, "wss://cdn.example.com/tcp", cfg.URL)
	require.NotNil(t, cfg.Endpoint)
}

func TestWebsocket_ExplicitEndpointAndHeaders(t *testing.T) {
	hdrs := http.Header{"User-Agent": []string{"TestAgent"}}
	parse := NewWebsocketEndpointParser(parseSEForTest(t, "backend.example.com:8443"),
		WithWebsocketHeaders(hdrs))
	cfg, err := parse(context.Background(),
		mustNode(t, "url: wss://cdn.example.com/tcp\nendpoint: backend.example.com:8443"))
	require.NoError(t, err)
	require.Equal(t, "TestAgent", cfg.Headers.Get("User-Agent"))

	// Headers are copied, not aliased: later parser calls must not share.
	cfg.Headers.Set("User-Agent", "Changed")
	cfg2, err := parse(context.Background(),
		mustNode(t, "url: wss://cdn.example.com/tcp\nendpoint: backend.example.com:8443"))
	require.NoError(t, err)
	require.Equal(t, "TestAgent", cfg2.Headers.Get("User-Agent"))
}

func TestWebsocket_InvalidURL(t *testing.T) {
	parse := NewWebsocketEndpointParser(parseSEForTest(t, ""))
	_, err := parse(context.Background(), mustNode(t, "url: \"://bad\""))
	require.Error(t, err)
}
