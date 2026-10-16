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
	"localhost/client/go/composer"
)

// fakeStreamDialer records the address it was asked to dial.
type fakeStreamDialer struct{ gotAddr string }

func (f *fakeStreamDialer) DialStream(ctx context.Context, addr string) (transport.StreamConn, error) {
	f.gotAddr = addr
	return nil, nil
}

func parseSDForTest(fake *fakeStreamDialer) composer.ParseFunc[StreamDialerConfig] {
	direct := NewDirectStreamDialerConfig(fake)
	return func(ctx context.Context, node composer.Node) (StreamDialerConfig, error) {
		return direct, nil
	}
}

func TestStreamDialEndpoint_Scalar(t *testing.T) {
	fake := &fakeStreamDialer{}
	parse := NewStreamDialEndpointParser(parseSDForTest(fake))
	cfg, err := parse(context.Background(), mustNode(t, `"example.com:443"`))
	require.NoError(t, err)
	require.Equal(t, "example.com:443", cfg.Address)

	ep, err := cfg.NewStreamEndpoint(context.Background())
	require.NoError(t, err)
	_, err = ep.ConnectStream(context.Background())
	require.NoError(t, err)
	require.Equal(t, "example.com:443", fake.gotAddr)
}

func TestStreamDialEndpoint_Mapping(t *testing.T) {
	fake := &fakeStreamDialer{}
	parse := NewStreamDialEndpointParser(parseSDForTest(fake))
	cfg, err := parse(context.Background(), mustNode(t, "$type: dial\naddress: example.com:8080"))
	require.NoError(t, err)
	require.Equal(t, "example.com:8080", cfg.Address)
	require.NotNil(t, cfg.Dialer)
}

func TestStreamDialEndpoint_AddressValidation(t *testing.T) {
	parse := NewStreamDialEndpointParser(parseSDForTest(&fakeStreamDialer{}))
	for _, bad := range []string{`"example.com"`, `":443"`, `"example.com:"`, `"example.com:0"`, `"example.com:99999"`} {
		_, err := parse(context.Background(), mustNode(t, bad))
		require.Error(t, err, "address %s must be rejected", bad)
	}
}

// This package never resolves: it dials Address exactly as the app left it.
func TestStreamDialEndpoint_DialsAddressVerbatim(t *testing.T) {
	fake := &fakeStreamDialer{}
	parse := NewStreamDialEndpointParser(parseSDForTest(fake))
	cfg, err := parse(context.Background(), mustNode(t, `"example.com:443"`))
	require.NoError(t, err)

	ep, err := cfg.NewStreamEndpoint(context.Background())
	require.NoError(t, err)
	_, err = ep.ConnectStream(context.Background())
	require.NoError(t, err)
	require.Equal(t, "example.com:443", fake.gotAddr, "the hostname must not be resolved here")

	// An app that rewrites Address to a resolved form gets that address dialed.
	cfg.Address = "203.0.113.7:443"
	ep, err = cfg.NewStreamEndpoint(context.Background())
	require.NoError(t, err)
	_, err = ep.ConnectStream(context.Background())
	require.NoError(t, err)
	require.Equal(t, "203.0.113.7:443", fake.gotAddr)
}
