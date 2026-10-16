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

package configregistry

import (
	"context"
	"fmt"
	"net/netip"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
	"localhost/client/go/composer/netconfig"
	"localhost/client/go/composer/registry"
)

// errorStreamDialer is a fake transport.StreamDialer that always fails,
// identifying itself by name in the error. Used to verify which dialer a
// dial-dispatch test routed to.
type errorStreamDialer struct {
	name string
}

func (d *errorStreamDialer) DialStream(ctx context.Context, addr string) (transport.StreamConn, error) {
	return nil, fmt.Errorf("dialer '%s' called for address '%s'", d.name, addr)
}

// parseSDErr is like the parseSD helper in metadata_test.go, but returns the
// parse error instead of requiring success. Needed here
// because iptable has several config-time error cases.
func parseSDErr(t *testing.T, text string) (netconfig.StreamDialerConfig, error) {
	t.Helper()
	r := registry.New()
	err := Register(r, &transport.TCPDialer{}, &transport.UDPDialer{})
	require.NoError(t, err)
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	ctx := WithMetadataCollection(context.Background())
	cfg, err := registry.Parser(r, netconfig.StreamDialerKind)(ctx, node)
	return cfg, err
}

// fakeSDConfig is a fake netconfig.StreamDialerConfig used to build
// IPTableStreamDialerConfig directly for dial-dispatch tests, without
// going through the registry/parser (which would require a real, dialable
// sub-config).
type fakeSDConfig struct {
	name string
}

func (f *fakeSDConfig) NewStreamDialer(ctx context.Context) (transport.StreamDialer, error) {
	return &errorStreamDialer{name: f.name}, nil
}

// Real, registry-backed dialer configs used to exercise ConnType
// aggregation through the full parser (as opposed to the dial-dispatch
// tests, which build IPTableStreamDialerConfig directly with fakes).
const (
	tunneledDialerYAML = `
      $type: shadowsocks
      endpoint: example.com:1234
      cipher: chacha20-ietf-poly1305
      secret: SECRET`
	tunneledDialerYAML2 = `
      $type: shadowsocks
      endpoint: example.com:5678
      cipher: chacha20-ietf-poly1305
      secret: SECRET2`
	directDialerYAML = `
      $type: direct`
	blockDialerYAML = `
      $type: block`
)

func TestIPTableConnType(t *testing.T) {
	testCases := []struct {
		name             string
		configYAML       string
		expectedConnType ConnType
	}{
		{
			name: "no fallback dialer, single tunneled entry",
			configYAML: `
table:
  - ips:
      - 192.168.1.0/24
    dialer:` + tunneledDialerYAML,
			expectedConnType: ConnTypeTunneled,
		},
		{
			name: "direct sub-dialer mixed with tunneled default -> partial",
			configYAML: `
table:
  - ips:
      - 192.168.1.0/24
    dialer:` + directDialerYAML + `
  - ips:
      - 0.0.0.0/0
    dialer:` + tunneledDialerYAML,
			expectedConnType: ConnTypePartial,
		},
		{
			name: "exhaustive IPv4, both tunneled",
			configYAML: `
table:
  - ips:
      - 0.0.0.0/1
    dialer:` + tunneledDialerYAML + `
  - ips:
      - 128.0.0.0/1
    dialer:` + tunneledDialerYAML2,
			expectedConnType: ConnTypeTunneled,
		},
		{
			name: "exhaustive IPv6, both tunneled",
			configYAML: `
table:
  - ips:
      - ::/1
    dialer:` + tunneledDialerYAML + `
  - ips:
      - 8000::/1
    dialer:` + tunneledDialerYAML2,
			expectedConnType: ConnTypeTunneled,
		},
		{
			name: "exhaustive IPv4 with direct -> partial",
			configYAML: `
table:
  - ips:
      - 0.0.0.0/1
    dialer:` + directDialerYAML + `
  - ips:
      - 128.0.0.0/1
    dialer:` + tunneledDialerYAML,
			expectedConnType: ConnTypePartial,
		},
		{
			name: "with tunneled fallback -> tunneled",
			configYAML: `
table:
  - ips:
      - 192.168.1.0/24
    dialer:` + tunneledDialerYAML + `
fallback:` + tunneledDialerYAML2,
			expectedConnType: ConnTypeTunneled,
		},
		{
			name: "with direct fallback -> partial",
			configYAML: `
table:
  - ips:
      - 192.168.1.0/24
    dialer:` + tunneledDialerYAML + `
fallback:` + directDialerYAML,
			expectedConnType: ConnTypePartial,
		},
		{
			name: "all direct (entry and fallback) -> direct",
			configYAML: `
table:
  - ips:
      - 192.168.1.0/24
    dialer:` + directDialerYAML + `
fallback:` + directDialerYAML,
			expectedConnType: ConnTypeDirect,
		},
		{
			name: "all blocked -> blocked",
			configYAML: `
table:
  - ips:
      - 0.0.0.0/0
    dialer:` + blockDialerYAML,
			expectedConnType: ConnTypeBlocked,
		},
		{
			name: "partial blocked: blocked entry excluded from vote -> tunneled",
			configYAML: `
table:
  - ips:
      - 192.168.1.0/24
    dialer:` + blockDialerYAML + `
  - ips:
      - 0.0.0.0/0
    dialer:` + tunneledDialerYAML,
			expectedConnType: ConnTypeTunneled,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			_, info := parseSDWithInfo(t, "$type: iptable\n"+tc.configYAML)
			require.Equal(t, tc.expectedConnType, info.ConnType)
			require.Empty(t, info.FirstHop)
		})
	}
}

func TestIPTableBareIPBecomesHostPrefix(t *testing.T) {
	cfg := parseSD(t, `
$type: iptable
table:
  - ips:
      - 10.0.0.1
      - 10.0.0.5
    dialer:`+tunneledDialerYAML+`
  - ips:
      - ::1
    dialer:`+tunneledDialerYAML2)

	table, ok := cfg.(*IPTableStreamDialerConfig)
	require.True(t, ok, "expected *IPTableStreamDialerConfig, got %T", cfg)
	require.Len(t, table.Entries, 2)

	require.Equal(t, []netip.Prefix{
		netip.MustParsePrefix("10.0.0.1/32"),
		netip.MustParsePrefix("10.0.0.5/32"),
	}, table.Entries[0].Prefixes)

	require.Equal(t, []netip.Prefix{
		netip.MustParsePrefix("::1/128"),
	}, table.Entries[1].Prefixes)
}

func TestIPTableErrors(t *testing.T) {
	testCases := []struct {
		name       string
		configYAML string
		expectErr  string
	}{
		{
			name:       "empty table",
			configYAML: "$type: iptable\ntable: []",
			expectErr:  "iptable config 'table' must not be empty",
		},
		{
			name: "missing dialer",
			configYAML: `
$type: iptable
table:
  - ips:
      - 192.168.1.0/24`,
			// The dialer field is a required composer.Node, so an omitted
			// key fails at decode time rather than reaching the explicit
			// "iptable entry N has no dialer specified" IsAbsent() check
			// (that check still guards an explicit "dialer: null").
			expectErr: `required field "dialer" is missing`,
		},
		{
			name: "explicit null dialer",
			configYAML: `
$type: iptable
table:
  - ips:
      - 192.168.1.0/24
    dialer: null`,
			expectErr: "iptable entry 0 has no dialer specified",
		},
		{
			name: "invalid IP",
			configYAML: `
$type: iptable
table:
  - ips:
      - not-an-ip
    dialer:` + tunneledDialerYAML + `
fallback: null`,
			expectErr: "is not a valid IP address or CIDR prefix",
		},
		{
			name: "sub-dialer parser fails",
			configYAML: `
$type: iptable
table:
  - ips:
      - 192.168.1.0/24
    dialer:
      $type: does-not-exist`,
			expectErr: "failed to parse dialer for table entry 0",
		},
		{
			name: "fallback parser fails",
			configYAML: `
$type: iptable
table:
  - ips:
      - 192.168.1.0/24
    dialer:` + tunneledDialerYAML + `
fallback:
  $type: does-not-exist`,
			expectErr: "failed to parse fallback dialer",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseSDErr(t, tc.configYAML)
			require.Error(t, err)
			require.ErrorContains(t, err, tc.expectErr)
		})
	}
}

// TestIPTableDialDispatch builds IPTableStreamDialerConfig directly with
// fake sub-dialers (per the brief: no test-only registry registrations)
// and verifies that DialStream routes to the right entry/fallback dialer
// by address.
func TestIPTableDialDispatch(t *testing.T) {
	ctx := context.Background()

	newCfg := func(fallback string) *IPTableStreamDialerConfig {
		cfg := &IPTableStreamDialerConfig{
			Entries: []IPTableEntryConfig{
				{
					Prefixes: []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24")},
					Dialer:   &fakeSDConfig{name: "dialerA"},
				},
				{
					Prefixes: []netip.Prefix{
						netip.MustParsePrefix("10.0.0.1/32"),
						netip.MustParsePrefix("10.0.0.5/32"),
					},
					Dialer: &fakeSDConfig{name: "dialerB"},
				},
			},
		}
		if fallback != "" {
			cfg.Fallback = &fakeSDConfig{name: fallback}
		}
		return cfg
	}

	t.Run("valid config with default (0.0.0.0/0) entry", func(t *testing.T) {
		cfg := newCfg("")
		cfg.Entries = append(cfg.Entries, IPTableEntryConfig{
			Prefixes: []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0")},
			Dialer:   &fakeSDConfig{name: "default"},
		})
		dialer, err := cfg.NewStreamDialer(ctx)
		require.NoError(t, err)

		_, err = dialer.DialStream(ctx, "192.168.1.100:1234")
		require.ErrorContains(t, err, "dialer 'dialerA' called for address '192.168.1.100:1234'")

		_, err = dialer.DialStream(ctx, "10.0.0.1:5678")
		require.ErrorContains(t, err, "dialer 'dialerB' called for address '10.0.0.1:5678'")

		_, err = dialer.DialStream(ctx, "10.0.0.5:53")
		require.ErrorContains(t, err, "dialer 'dialerB' called for address '10.0.0.5:53'")

		_, err = dialer.DialStream(ctx, "8.8.8.8:53")
		require.ErrorContains(t, err, "dialer 'default' called for address '8.8.8.8:53'")
	})

	t.Run("no fallback dialer, out-of-table address routes to entry only", func(t *testing.T) {
		cfg := newCfg("")
		dialer, err := cfg.NewStreamDialer(ctx)
		require.NoError(t, err)

		_, err = dialer.DialStream(ctx, "192.168.1.100:1234")
		require.ErrorContains(t, err, "dialer 'dialerA' called for address '192.168.1.100:1234'")
	})

	t.Run("with fallback dialer", func(t *testing.T) {
		cfg := newCfg("default")
		dialer, err := cfg.NewStreamDialer(ctx)
		require.NoError(t, err)

		_, err = dialer.DialStream(ctx, "192.168.1.100:1234")
		require.ErrorContains(t, err, "dialer 'dialerA' called for address '192.168.1.100:1234'")

		_, err = dialer.DialStream(ctx, "8.8.8.8:53")
		require.ErrorContains(t, err, "dialer 'default' called for address '8.8.8.8:53'")
	})

	t.Run("no fallback, out-of-table address errors", func(t *testing.T) {
		cfg := newCfg("")
		dialer, err := cfg.NewStreamDialer(ctx)
		require.NoError(t, err)

		_, err = dialer.DialStream(ctx, "8.8.8.8:53")
		require.ErrorContains(t, err, "no dialer available for address 8.8.8.8:53")
	})
}
