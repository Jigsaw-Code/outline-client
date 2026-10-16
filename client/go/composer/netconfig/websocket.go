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
	"fmt"
	"net"
	"net/http"
	"net/url"

	"golang.getoutline.org/sdk/transport"
	"golang.getoutline.org/sdk/x/websocket"
	"localhost/client/go/composer"
)

// WebsocketEndpointConfig tunnels a stream or packet connection over a
// websocket. Both variants ride over an inner stream endpoint.
type WebsocketEndpointConfig struct {
	URL      string
	Headers  http.Header
	Endpoint StreamEndpointConfig
}

func (c *WebsocketEndpointConfig) options() []websocket.Option {
	if len(c.Headers) == 0 {
		return nil
	}
	return []websocket.Option{websocket.WithHTTPHeaders(c.Headers)}
}

func (c *WebsocketEndpointConfig) NewStreamEndpoint(ctx context.Context) (transport.StreamEndpoint, error) {
	se, err := c.Endpoint.NewStreamEndpoint(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build websocket inner endpoint: %w", err)
	}
	connect, err := websocket.NewStreamEndpoint(c.URL, se, c.options()...)
	if err != nil {
		return nil, err
	}
	return transport.FuncStreamEndpoint(connect), nil
}

func (c *WebsocketEndpointConfig) NewPacketEndpoint(ctx context.Context) (transport.PacketEndpoint, error) {
	se, err := c.Endpoint.NewStreamEndpoint(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to build websocket inner endpoint: %w", err)
	}
	connect, err := websocket.NewPacketEndpoint(c.URL, se, c.options()...)
	if err != nil {
		return nil, err
	}
	return transport.FuncPacketEndpoint(connect), nil
}

type websocketOptions struct {
	headers http.Header
}

type WebsocketOption func(*websocketOptions)

// WithWebsocketHeaders sets default headers (e.g. an app User-Agent)
// on every parsed websocket config. The headers are cloned per config.
func WithWebsocketHeaders(h http.Header) WebsocketOption {
	return func(o *websocketOptions) { o.headers = h }
}

type websocketFields struct {
	URL      string
	Endpoint composer.Optional[composer.Node]
}

// NewWebsocketEndpointParser parses a websocket endpoint config.
func NewWebsocketEndpointParser(parseSE composer.ParseFunc[StreamEndpointConfig], opts ...WebsocketOption) composer.ParseFunc[*WebsocketEndpointConfig] {
	var options websocketOptions
	for _, o := range opts {
		o(&options)
	}
	return func(ctx context.Context, node composer.Node) (*WebsocketEndpointConfig, error) {
		var f websocketFields
		if err := node.Decode(&f); err != nil {
			return nil, err
		}
		u, err := url.Parse(f.URL)
		if err != nil {
			return nil, fmt.Errorf("url is invalid: %w", err)
		}
		port := u.Port()
		switch u.Scheme {
		case "https", "wss":
			u.Scheme = "wss"
			if port == "" {
				port = "443"
			}
		case "http", "ws":
			u.Scheme = "ws"
			if port == "" {
				port = "80"
			}
		default:
			return nil, fmt.Errorf("unsupported websocket scheme %q", u.Scheme)
		}
		if u.Hostname() == "" {
			return nil, fmt.Errorf("websocket url has no host")
		}

		endpointNode, ok := f.Endpoint.Get()
		if !ok {
			endpointNode, err = scalarNode(net.JoinHostPort(u.Hostname(), port))
			if err != nil {
				return nil, err
			}
		}
		inner, err := parseSE(ctx, endpointNode)
		if err != nil {
			return nil, fmt.Errorf("failed to parse websocket endpoint: %w", err)
		}
		return &WebsocketEndpointConfig{
			URL:      u.String(),
			Headers:  options.headers.Clone(),
			Endpoint: inner,
		}, nil
	}
}
