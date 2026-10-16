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
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
)

func parseSEEcho() composer.ParseFunc[StreamEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (StreamEndpointConfig, error) {
		return &fakeSE{}, nil
	}
}

type fakePE struct{}

func (fakePE) NewPacketEndpoint(ctx context.Context) (transport.PacketEndpoint, error) {
	return transport.FuncPacketEndpoint(func(ctx context.Context) (net.Conn, error) {
		return nil, nil
	}), nil
}

func TestShadowsocks_MappingConfig(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	cfg, err := parse(context.Background(), mustNode(t, `
$type: shadowsocks
endpoint: example.com:1234
cipher: chacha20-ietf-poly1305
secret: SECRET
prefix: "POST "
`))
	require.NoError(t, err)
	require.NotNil(t, cfg.Endpoint)
	sd, err := cfg.NewStreamDialer(context.Background())
	require.NoError(t, err)
	require.NotNil(t, sd)
}

func TestShadowsocks_LegacyMapping(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	_, err := parse(context.Background(), mustNode(t, `
server: example.com
server_port: 1234
method: chacha20-ietf-poly1305
password: SECRET
`))
	require.NoError(t, err)
}

func TestShadowsocks_SIP002URL(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	// base64("chacha20-ietf-poly1305:SECRET") = Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ
	_, err := parse(context.Background(),
		mustNode(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`))
	require.NoError(t, err)
}

// Worked example from the brief: parseShadowsocksNode (the netconfig
// equivalent of legacy parseShadowsocksConfig) must thread the URL's host
// through to endpointAddress.
func TestShadowsocksNode_SIP002URL_EndpointAddress(t *testing.T) {
	res, err := parseShadowsocksNode(mustNode(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:1234"`))
	require.NoError(t, err)
	require.Equal(t, "example.com:1234", res.endpointAddress)
}

func TestShadowsocks_Validation(t *testing.T) {
	parse := NewShadowsocksStreamDialerParser(parseSEEcho())
	for name, bad := range map[string]string{
		"missing cipher":   "endpoint: e:1\nsecret: s",
		"missing secret":   "endpoint: e:1\ncipher: aes-128-gcm",
		"missing endpoint": "cipher: aes-128-gcm\nsecret: s",
		"bad cipher":       "endpoint: e:1\ncipher: nope\nsecret: s",
		"bad prefix":       "endpoint: e:1\ncipher: aes-128-gcm\nsecret: s\nprefix: \"\\u0800\"",
	} {
		_, err := parse(context.Background(), mustNode(t, bad))
		require.Error(t, err, name)
	}
}

func TestShadowsocks_PacketListenerAndDialer(t *testing.T) {
	parsePE := func(ctx context.Context, node composer.Node) (PacketEndpointConfig, error) {
		return &fakePE{}, nil
	}

	listenerParse := NewShadowsocksPacketListenerParser(parsePE)
	lcfg, err := listenerParse(context.Background(), mustNode(t, `
endpoint: example.com:1234
cipher: chacha20-ietf-poly1305
secret: SECRET
`))
	require.NoError(t, err)
	pl, err := lcfg.NewPacketListener(context.Background())
	require.NoError(t, err)
	require.NotNil(t, pl)

	dialerParse := NewShadowsocksPacketDialerParser(parsePE)
	dcfg, err := dialerParse(context.Background(), mustNode(t, `
endpoint: example.com:1234
cipher: chacha20-ietf-poly1305
secret: SECRET
prefix: "POST "
`))
	require.NoError(t, err)
	pd, err := dcfg.NewPacketDialer(context.Background())
	require.NoError(t, err)
	require.NotNil(t, pd)
}

// --- Ported from the former app-layer Shadowsocks parser tests.
// (TestParseShadowsocksConfig_URL). These exercise the moved URL/prefix
// helpers directly, since ssParams (the output of parseShadowsocksNode)
// intentionally folds cipher+secret into an opaque *shadowsocks.EncryptionKey
// and no longer exposes them for string comparison.

func TestShadowsocksURL_FullyBase64Encoded(t *testing.T) {
	encoded := base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString([]byte("chacha20-ietf-poly1305:SECRET/!@#@example.com:1234?prefix=HTTP%2F1.1%20"))
	u, err := url.Parse("ss://" + encoded + "#outline-123")
	require.NoError(t, err)
	res, err := parseShadowsocksURL(*u)
	require.NoError(t, err)
	require.Equal(t, "example.com:1234", res.Endpoint)
	require.Equal(t, "chacha20-ietf-poly1305", res.Cipher)
	require.Equal(t, "SECRET/!@#", res.Secret)
	require.Equal(t, "HTTP/1.1 ", res.Prefix)
}

func TestShadowsocksURL_FullyBase64EncodedWithPasswordContainingHost(t *testing.T) {
	encoded := base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString([]byte("chacha20-ietf-poly1305:SECRET@example.com:80@example.com:1234?prefix=HTTP%2F1.1%20"))
	u, err := url.Parse("ss://" + encoded + "#outline-123")
	require.NoError(t, err)
	res, err := parseShadowsocksURL(*u)
	require.NoError(t, err)
	require.Equal(t, "example.com:1234", res.Endpoint)
	require.Equal(t, "SECRET@example.com:80", res.Secret)
}

func TestShadowsocksURL_FullyBase64EncodedWithAmbiguousQueryParameterParsesGreedily(t *testing.T) {
	encoded := base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString([]byte("chacha20-ietf-poly1305:SECRET/!@#@example.com:1234?prefix=@bad.example.com:443"))
	u, err := url.Parse("ss://" + encoded + "#outline-123")
	require.NoError(t, err)
	res, err := parseShadowsocksURL(*u)
	require.NoError(t, err)
	require.Equal(t, "bad.example.com:443", res.Endpoint)
	require.Equal(t, "SECRET/!@#@example.com:1234?prefix=", res.Secret)
}

func TestShadowsocksURL_UserInfoBase64Encoded(t *testing.T) {
	encoded := base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString([]byte("chacha20-ietf-poly1305:SECRET/!@#"))
	u, err := url.Parse("ss://" + encoded + "@example.com:1234?prefix=HTTP%2F1.1%20" + "#outline-123")
	require.NoError(t, err)
	res, err := parseShadowsocksURL(*u)
	require.NoError(t, err)
	require.Equal(t, "example.com:1234", res.Endpoint)
	require.Equal(t, "chacha20-ietf-poly1305", res.Cipher)
	require.Equal(t, "SECRET/!@#", res.Secret)
	require.Equal(t, "HTTP/1.1 ", res.Prefix)
}

func TestShadowsocksURL_UserInfoBase64LegacyEncoded(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte("chacha20-ietf-poly1305:SECRET/!@#"))
	u, err := url.Parse("ss://" + encoded + "@example.com:1234?prefix=HTTP%2F1.1%20" + "#outline-123")
	require.NoError(t, err)
	res, err := parseShadowsocksURL(*u)
	require.NoError(t, err)
	require.Equal(t, "example.com:1234", res.Endpoint)
	require.Equal(t, "chacha20-ietf-poly1305", res.Cipher)
	require.Equal(t, "SECRET/!@#", res.Secret)
	require.Equal(t, "HTTP/1.1 ", res.Prefix)
}

func TestShadowsocksURL_UserInfoPercentEncoding(t *testing.T) {
	configString := fmt.Sprintf("ss://%s:%s@example.com:1234",
		url.QueryEscape("chacha20-ietf-poly1305"),
		url.QueryEscape("SECRET/!@#"),
	)
	u, err := url.Parse(configString)
	require.NoError(t, err)
	res, err := parseShadowsocksURL(*u)
	require.NoError(t, err)
	require.Equal(t, "example.com:1234", res.Endpoint)
	require.Equal(t, "chacha20-ietf-poly1305", res.Cipher)
	require.Equal(t, "SECRET/!@#", res.Secret)
}

// The following two port "Invalid Cipher Fails" and "Unsupported Cipher
// Fails" through the full parseShadowsocksNode pipeline (mirroring legacy
// parseShadowsocksParams), since cipher-name validity is only checked once
// shadowsocks.NewEncryptionKey runs.
func TestShadowsocksNode_InvalidCipherInfoFails(t *testing.T) {
	_, err := parseShadowsocksNode(mustNode(t, `"ss://chacha20-ietf-poly13051234567@example.com:1234"`))
	require.Error(t, err)
}

func TestShadowsocksNode_UnsupportedCipherFails(t *testing.T) {
	_, err := parseShadowsocksNode(mustNode(t, `"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwnTpLeTUyN2duU3FEVFB3R0JpQ1RxUnlT@example.com:1234"`))
	require.Error(t, err)
}
