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

package composer_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"localhost/client/go/composer"

	"github.com/stretchr/testify/require"
)

// A miniature transport model mirroring Outline's app registry shape:
// endpoints wrap dialers, transports wrap endpoints.
type endpoint struct {
	desc string
}

type transport struct {
	endpoint *endpoint
	cipher   string
	padding  int
}

func newEndpointParser() *composer.TypeParser[*endpoint] {
	var endpoints *composer.TypeParser[*endpoint]
	endpoints = composer.NewTypeParser(func(ctx context.Context, node composer.Node) (*endpoint, error) {
		var addr string
		if err := node.Decode(&addr); err != nil {
			return nil, fmt.Errorf("endpoint must be an address string: %w", err)
		}
		return &endpoint{desc: "dial " + addr}, nil
	})
	type wsConfig struct {
		URL      string
		Endpoint composer.Optional[composer.Node]
	}
	composer.RegisterParser(endpoints, "websocket", func(ctx context.Context, cfg wsConfig) (*endpoint, error) {
		inner := "derived"
		if epNode, ok := cfg.Endpoint.Get(); ok {
			ep, err := endpoints.Parse(ctx, epNode)
			if err != nil {
				return nil, err
			}
			inner = ep.desc
		}
		return &endpoint{desc: fmt.Sprintf("ws %s over (%s)", cfg.URL, inner)}, nil
	})
	return endpoints
}

func newTransportParser(endpoints *composer.TypeParser[*endpoint]) *composer.TypeParser[*transport] {
	transports := composer.NewTypeParser(func(ctx context.Context, node composer.Node) (*transport, error) {
		return nil, errors.New("parser not specified")
	})
	type ssConfig struct {
		Endpoint composer.Node
		Cipher   string
		Padding  composer.Optional[int]
	}
	composer.RegisterParser(transports, "ss", func(ctx context.Context, cfg ssConfig) (*transport, error) {
		ep, err := endpoints.Parse(ctx, cfg.Endpoint)
		if err != nil {
			return nil, err
		}
		return &transport{endpoint: ep, cipher: cfg.Cipher, padding: cfg.Padding.Or(0)}, nil
	})
	return transports
}

const fullConfig = `
$defs:
  proxy_addr: &proxy "proxy.example.com:443"
$type: first-supported
options:
  - $type: quantum-tunnel
    endpoint: *proxy
  - $type: ss
    cipher: chacha20-ietf-poly1305
    padding?: 16
    experimental_knob?: true
    endpoint:
      $type: websocket
      url: wss://cdn.example.com/tcp
      endpoint: *proxy
`

func TestIntegration_FullConfig(t *testing.T) {
	root, err := composer.ParseYAML([]byte(fullConfig))
	require.NoError(t, err)

	transports := newTransportParser(newEndpointParser())
	tr, err := transports.Parse(context.Background(), root)
	require.NoError(t, err)
	require.Equal(t, "chacha20-ietf-poly1305", tr.cipher)
	require.Equal(t, 16, tr.padding, "known ?-field is used")
	require.Equal(t, "ws wss://cdn.example.com/tcp over (dial proxy.example.com:443)",
		tr.endpoint.desc, "anchor + delegated node resolve through the chain")
}

func TestIntegration_ErrorGoldens(t *testing.T) {
	transports := newTransportParser(newEndpointParser())
	parse := func(text string) error {
		root, err := composer.ParseYAML([]byte(text))
		require.NoError(t, err)
		_, err = transports.Parse(context.Background(), root)
		return err
	}

	tests := []struct {
		name, yaml string
		want       []string // substrings the provider-facing error must contain
	}{
		{
			name: "unknown type",
			yaml: "$type: warp-drive",
			want: []string{"warp-drive", "not supported"},
		},
		{
			name: "unknown required field with position",
			yaml: "$type: ss\ncipher: aes\nendpoint: e:443\ntypo_field: 1",
			want: []string{"typo_field", "line 4"},
		},
		{
			name: "missing required field",
			yaml: "$type: ss\ncipher: aes",
			want: []string{"endpoint", "missing"},
		},
		{
			name: "nested error carries path",
			yaml: "$type: ss\ncipher: aes\nendpoint:\n  $type: websocket\n  url: 123",
			want: []string{"url", "line 5"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := parse(tc.yaml)
			require.Error(t, err)
			for _, want := range tc.want {
				require.Contains(t, err.Error(), want)
			}
			t.Logf("golden: %v", err)
		})
	}
}
