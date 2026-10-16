// Copyright 2024 The Outline Authors
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

package outline

import (
	"encoding/json"
	"testing"

	"localhost/client/go/outline/configregistry"
	"localhost/client/go/outline/platerrors"

	"github.com/goccy/go-yaml"
	"github.com/goccy/go-yaml/ast"
	"github.com/stretchr/testify/require"
)

// parsedTunnelResultJSON is a helper struct to unmarshal the JSON output of doParseTunnelConfig.
type parsedTunnelResultJSON struct {
	Client   string `json:"client"`
	FirstHop string `json:"firstHop"`
}

func parseFirstHopAndTunnelConfigJSON(t *testing.T, jsonStr string) parsedTunnelResultJSON {
	t.Helper()
	var parsed parsedTunnelResultJSON
	err := json.Unmarshal([]byte(jsonStr), &parsed)
	require.NoError(t, err, "Failed to unmarshal JSON output from doParseTunnelConfig: %s", jsonStr)
	return parsed
}

// matchClientConfig is a helper to match the clientConfigString against the `client` field in the firstHopAndTunnelConfigString JSON.
func matchClientConfig(t *testing.T, clientConfigString string, firstHopAndTunnelConfigString string) {
	t.Helper()

	var firstHopAndTunnelConfigValue map[string]any
	require.NoError(t, json.Unmarshal([]byte(firstHopAndTunnelConfigString), &firstHopAndTunnelConfigValue))

	var expected, actual map[string]any
	require.NoError(t, yaml.Unmarshal([]byte(clientConfigString), &expected))
	require.NoError(t, yaml.Unmarshal([]byte(firstHopAndTunnelConfigValue["client"].(string)), &actual))
	require.Equal(t, expected, actual)
}

// matchTransportConfig is a helper to match the transportConfigString against the `client.transport` field in the firstHopAndTunnelConfigString JSON.
func matchTransportConfig(t *testing.T, transportConfigString string, firstHopAndTunnelConfigString string) {
	t.Helper()

	var expected any
	require.NoError(t, yaml.Unmarshal([]byte(transportConfigString), &expected))

	var actual map[string]any
	var firstHopAndTunnelConfigValue map[string]any
	require.NoError(t, json.Unmarshal([]byte(firstHopAndTunnelConfigString), &firstHopAndTunnelConfigValue))
	require.NoError(t, yaml.Unmarshal([]byte(firstHopAndTunnelConfigValue["client"].(string)), &actual))

	require.Equal(t, expected, actual["transport"])
}

func TestCombinedConnectionType(t *testing.T) {
	testCases := []struct {
		name           string
		streamConnType configregistry.ConnType
		packetConnType configregistry.ConnType
		expected       configregistry.ConnType
	}{
		// Matching types
		{"Direct-Direct", configregistry.ConnTypeDirect, configregistry.ConnTypeDirect, configregistry.ConnTypeDirect},
		{"Tunneled-Tunneled", configregistry.ConnTypeTunneled, configregistry.ConnTypeTunneled, configregistry.ConnTypeTunneled},
		{"Partial-Partial", configregistry.ConnTypePartial, configregistry.ConnTypePartial, configregistry.ConnTypePartial},
		{"Blocked-Blocked", configregistry.ConnTypeBlocked, configregistry.ConnTypeBlocked, configregistry.ConnTypeBlocked},

		// One is Partial
		{"Direct-Partial", configregistry.ConnTypeDirect, configregistry.ConnTypePartial, configregistry.ConnTypePartial},
		{"Partial-Direct", configregistry.ConnTypePartial, configregistry.ConnTypeDirect, configregistry.ConnTypePartial},
		{"Tunneled-Partial", configregistry.ConnTypeTunneled, configregistry.ConnTypePartial, configregistry.ConnTypePartial},
		{"Partial-Tunneled", configregistry.ConnTypePartial, configregistry.ConnTypeTunneled, configregistry.ConnTypePartial},
		{"Blocked-Partial", configregistry.ConnTypeBlocked, configregistry.ConnTypePartial, configregistry.ConnTypePartial},
		{"Partial-Blocked", configregistry.ConnTypePartial, configregistry.ConnTypeBlocked, configregistry.ConnTypePartial},

		// One is Blocked
		{"Direct-Blocked", configregistry.ConnTypeDirect, configregistry.ConnTypeBlocked, configregistry.ConnTypeDirect},
		{"Blocked-Direct", configregistry.ConnTypeBlocked, configregistry.ConnTypeDirect, configregistry.ConnTypeDirect},
		{"Tunneled-Blocked", configregistry.ConnTypeTunneled, configregistry.ConnTypeBlocked, configregistry.ConnTypeTunneled},
		{"Blocked-Tunneled", configregistry.ConnTypeBlocked, configregistry.ConnTypeTunneled, configregistry.ConnTypeTunneled},

		// Split between transports
		{"Direct-Tunneled", configregistry.ConnTypeDirect, configregistry.ConnTypeTunneled, configregistry.ConnTypePartial},
		{"Tunneled-Direct", configregistry.ConnTypeTunneled, configregistry.ConnTypeDirect, configregistry.ConnTypePartial},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			result := combinedConnectionType(tc.streamConnType, tc.packetConnType)
			require.Equal(t, tc.expected, result)
		})
	}
}

func Test_doParseTunnel_SSURL(t *testing.T) {
	transportConfig := "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:4321/"
	result := doParseTunnelConfig(transportConfig)
	require.Nil(t, result.Error)
	require.Equal(t,
		`{"client":"{\"transport\":\"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:4321/\"}","firstHop":"example.com:4321","connectionType":"tunneled"}`,
		result.Value)

	matchTransportConfig(t, transportConfig, result.Value)
}

func Test_doParseTunnel_SSURL_With_Comment(t *testing.T) {
	transportConfig := "# Comment\nss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:4321/"
	result := doParseTunnelConfig(transportConfig)
	require.Nil(t, result.Error)
	require.Equal(t,
		`{"client":"{\"transport\":\"ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:4321/\"}","firstHop":"example.com:4321","connectionType":"tunneled"}`,
		result.Value)

	matchTransportConfig(t, transportConfig, result.Value)
}

func Test_doParseTunnel_LegacyJSON(t *testing.T) {
	transportConfig := `{
    "server": "example.com",
    "server_port": 4321,
    "method": "chacha20-ietf-poly1305",
    "password": "SECRET",
	"prefix": "SSH-2.0\r\n"
}`
	result := doParseTunnelConfig(transportConfig)
	require.Nil(t, result.Error)
	require.Equal(t,
		`{"client":"{\"transport\":{\"method\":\"chacha20-ietf-poly1305\",\"password\":\"SECRET\",\"prefix\":\"SSH-2.0\\r\\n\",\"server\":\"example.com\",\"server_port\":4321}}","firstHop":"example.com:4321","connectionType":"tunneled"}`,
		result.Value)

	matchTransportConfig(t, transportConfig, result.Value)
}

func Test_doParseTunnelConfig(t *testing.T) {
	clientConfig := `
transport:
  $type: tcpudp
  tcp: &shared
    $type: shadowsocks
    endpoint: example.com:80
    cipher: chacha20-ietf-poly1305
    secret: SECRET
  udp: *shared`

	result := doParseTunnelConfig(clientConfig)

	require.Nil(t, result.Error)
	require.Equal(t,
		`{"client":"{\"transport\":{\"$type\":\"tcpudp\",\"tcp\":{\"$type\":\"shadowsocks\",\"cipher\":\"chacha20-ietf-poly1305\",\"endpoint\":\"example.com:80\",\"secret\":\"SECRET\"},\"udp\":{\"$type\":\"shadowsocks\",\"cipher\":\"chacha20-ietf-poly1305\",\"endpoint\":\"example.com:80\",\"secret\":\"SECRET\"}}}","firstHop":"example.com:80","connectionType":"tunneled"}`,
		result.Value)

	matchClientConfig(t, clientConfig, result.Value)
}

func Test_doParseTunnelConfig_ProviderError(t *testing.T) {
	result := doParseTunnelConfig(`
error:
  message: Unauthorized
  details: Account expired
`)

	require.Equal(t, result.Error, &platerrors.PlatformError{
		Code:    platerrors.ProviderError,
		Message: "Unauthorized",
		Details: map[string]any{
			"details": "Account expired",
		},
	})
}

func Test_doParseTunnelConfig_ProviderErrorJSON(t *testing.T) {
	result := doParseTunnelConfig(`
{
  "error": {
    "message": "\u26a0 Invalid Access Key \/ Key \u1000\u102d\u102f\u1015\u103c\u1014\u103a\u101c\u100a\u103a\u1005\u1005\u103a\u1006\u1031\u1038\u1015\u1031\u1038\u1015\u102b\u104b",
    "details": "\u26a0 Details \/ Key \u1000\u102d\u102f\u1015\u103c\u1014\u103a\u101c\u100a\u103a\u1005\u1005\u103a\u1006\u1031\u1038\u1015\u1031\u1038\u1015\u102b\u104b"
  }
}`)

	require.Equal(t, &platerrors.PlatformError{
		Code:    platerrors.ProviderError,
		Message: "⚠ Invalid Access Key / Key ကိုပြန်လည်စစ်ဆေးပေးပါ။",
		Details: map[string]any{
			"details": "⚠ Details / Key ကိုပြန်လည်စစ်ဆေးပေးပါ။",
		},
	}, result.Error)
}

func TestParseConfig_SS_URL(t *testing.T) {
	userInputConfig := "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@example.com:4321/"
	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Legacy_JSON(t *testing.T) {
	userInputConfig := `{
    "server": "example.com",
    "server_port": 4321,
    "method": "chacha20-ietf-poly1305",
    "password": "SECRET"
}`
	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Legacy_JSON_WithPrefix(t *testing.T) {
	userInputConfig := `{
    "server": "example.com",
    "server_port": 4321,
    "method": "chacha20-ietf-poly1305",
    "password": "SECRET",
    "prefix": "SSH-2.0\r\n"
}`
	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Legacy_JSONFlow_WithPrefix(t *testing.T) {
	userInputConfig := `{server: "example.com", server_port: 4321, method: "chacha20-ietf-poly1305", password: "SECRET", prefix: "SSH-2.0\r\n"}`

	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_JSON_WithPrefix(t *testing.T) {
	userInputConfig := `transport: {
    "server": "example.com",
    "server_port": 4321,
    "method": "chacha20-ietf-poly1305",
    "password": "SECRET",
    "prefix": "SSH-2.0\r\n"
}`
	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchClientConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_Explicit_Full(t *testing.T) {
	userInputConfig := `
transport:
  $type: tcpudp
  tcp:
      $type: shadowsocks
      endpoint: example.com:80
      cipher: chacha20-ietf-poly1305
      secret: SECRET
      prefix: "POST "
  udp:
      $type: shadowsocks
      endpoint: example.com:53
      cipher: chacha20-ietf-poly1305
      secret: SECRET
      prefix: "SSH-2.0\r\n"`

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	matchClientConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Flexible_JSON(t *testing.T) {
	userInputConfig := `{
    # Comment
    server: example.com,
    server_port: 4321,
    method: chacha20-ietf-poly1305,
    password: SECRET,
	prefix: "SSH-2.0\r\n"
}`
	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_YAML(t *testing.T) {
	// This input is the transport part of a ClientConfig.
	// doParseTunnelConfig will treat it as a "legacy" format and wrap it.
	userInputConfig := `# Comment
server: example.com
server_port: 4321
method: chacha20-ietf-poly1305
password: SECRET
prefix: "SSH-2.0\r\n"`
	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_Explicit_Endpoint(t *testing.T) {
	userInputConfig := `
endpoint:
    $type: dial
    address: example.com:4321
cipher: chacha20-ietf-poly1305
secret: SECRET
prefix: "SSH-2.0\r\n"`
	expectedFirstHop := "example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_Multihop_URL(t *testing.T) {
	userInputConfig := `
endpoint:
    $type: dial
    address: exit.example.com:4321
    dialer: ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpTRUNSRVQ@entry.example.com:4321/
cipher: chacha20-ietf-poly1305
secret: SECRET
prefix: "SSH-2.0\r\n"`
	expectedFirstHop := "entry.example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_Multihop_Explicit(t *testing.T) {
	userInputConfig := `
endpoint:
    $type: dial
    address: exit.example.com:4321
    dialer: 
      $type: shadowsocks
      endpoint: entry.example.com:4321
      cipher: chacha20-ietf-poly1305
      secret: ENTRY_SECRET
cipher: chacha20-ietf-poly1305
secret: EXIT_SECRET
prefix: "SSH-2.0\r\n"`
	expectedFirstHop := "entry.example.com:4321"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	require.Equal(t, expectedFirstHop, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_Explicit_TCPUDP(t *testing.T) {
	userInputConfig := `
$type: tcpudp
tcp:
    $type: shadowsocks
    endpoint: example.com:80
    cipher: chacha20-ietf-poly1305
    secret: SECRET
    prefix: "POST "
udp:
    $type: shadowsocks
    endpoint: example.com:53
    cipher: chacha20-ietf-poly1305
    secret: SECRET
    prefix: "SSH-2.0\r\n"`
	expectedSdFirstHop := "example.com:80"
	expectedPlFirstHop := "example.com:53"

	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	// FirstHop in JSON output will be empty because sd and pl hops are different
	require.Empty(t, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, expectedSdFirstHop, clientResult.Client.sdInfo.FirstHop)
	require.Equal(t, expectedPlFirstHop, clientResult.Client.prInfo.FirstHop)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_Transport_Unsupported(t *testing.T) {
	userInputConfig := `$type: unsupported` // This is a transport config
	result := doParseTunnelConfig(userInputConfig)
	require.NotNil(t, result.Error, "Expected an error for unsupported config")
	require.Equal(t, platerrors.InvalidConfig, result.Error.Code)
	// The message comes from NewClient's error wrapping
	require.Contains(t, result.Error.Message, "unsupported config")
}

func TestParseConfig_InvalidReporter(t *testing.T) {
	result := doParseTunnelConfig(`
transport:
  $type: tcpudp
reporter:
  $type: http
  request:
    url: https://collector.example.com/report
  interval: 10m
`)
	require.NotNil(t, result.Error)
	require.Equal(t, platerrors.InvalidConfig, result.Error.Code)
	require.Equal(t, "invalid reporter config", result.Error.Message)
}

func TestParseConfig_Transport_AllowProxylessTCP(t *testing.T) {
	userInputConfig := `
$type: tcpudp
tcp: # results in direct dialer
udp:
    $type: shadowsocks
    endpoint: example.com:53
    cipher: chacha20-ietf-poly1305
    secret: SECRET
    prefix: "SSH-2.0\r\n"`
	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	parsedOutput := parseFirstHopAndTunnelConfigJSON(t, result.Value)
	// FirstHop in JSON output will be empty because sd and pl hops are different
	require.Empty(t, parsedOutput.FirstHop)

	clientResult := (&ClientParser{}).NewClient("", parsedOutput.Client)
	require.Nil(t, clientResult.Error, "NewClient failed with parsed client config: %v", clientResult.Error)
	require.NotNil(t, clientResult.Client)
	require.Equal(t, configregistry.ConnTypeDirect, clientResult.Client.sdInfo.ConnType)
	require.Equal(t, configregistry.ConnTypeTunneled, clientResult.Client.prInfo.ConnType)

	matchTransportConfig(t, userInputConfig, result.Value)
}

func TestParseConfig_ClientFromJSON_Errors(t *testing.T) {
	tests := []struct {
		name  string
		input string // This is the "legacy JSON" input for doParseTunnelConfig
	}{
		{"missing host", `{"port":12345,"method":"some-cipher","password":"abcd1234"}`},
		{"missing port", `{"host":"192.0.2.1","method":"some-cipher","password":"abcd1234"}`},
		{"missing method", `{"host":"192.0.2.1","port":12345,"password":"abcd1234"}`},
		{"missing password", `{"host":"192.0.2.1","port":12345,"method":"some-cipher"}`},
		{"empty host", `{"host":"","port":12345,"method":"some-cipher","password":"abcd1234"}`},
		{"zero port", `{"host":"192.0.2.1","port":0,"method":"some-cipher","password":"abcd1234"}`},
		{"empty method", `{"host":"192.0.2.1","port":12345,"method":"","password":"abcd1234"}`},
		{"empty password", `{"host":"192.0.2.1","port":12345,"method":"some-cipher","password":""}`},
		{"port -1", `{"host":"192.0.2.1","port":-1,"method":"some-cipher","password":"abcd1234"}`},
		{"port 65536", `{"host":"192.0.2.1","port":65536,"method":"some-cipher","password":"abcd1234"}`},
		{"prefix out-of-range", `{"host":"192.0.2.1","port":8080,"method":"some-cipher","password":"abcd1234","prefix":"\x1234"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := doParseTunnelConfig(tt.input)
			require.NotNil(t, got.Error, "doParseTunnelConfig() expected an error for input: %s", tt.input)
			// The specific error message might be "failed to create transport" due to wrapping in NewClient
			// or "failed to parse" if it's a very early syntax error for the legacy JSON.
			// For simplicity, we just check that an error of InvalidConfig type is returned.
			require.Equal(t, platerrors.InvalidConfig, got.Error.Code, "Unexpected error code for input: %s", tt.input)
		})
	}
}

func Test_doParseTunnelConfig_ProviderErrorUTF8(t *testing.T) {
	result := doParseTunnelConfig(`
error:
  message: "\u26a0 Invalid Access Key / Key \u1000\u102d\u102f\u1015\u103c\u1014\u103a\u101c\u100a\u103a\u1005\u1005\u103a\u1006\u1031\u1038\u1015\u1031\u1038\u1015\u102b\u104b"
  details: "\u26a0 Details / Key \u1000\u102d\u102f\u1015\u103c\u1014\u103a\u101c\u100a\u103a\u1005\u1005\u103a\u1006\u1031\u1038\u1015\u1031\u1038\u1015\u102b\u104b"
`)

	require.Equal(t, &platerrors.PlatformError{
		Code:    platerrors.ProviderError,
		Message: "⚠ Invalid Access Key / Key ကိုပြန်လည်စစ်ဆေးပေးပါ။",
		Details: map[string]any{
			"details": "⚠ Details / Key ကိုပြန်လည်စစ်ဆေးပေးပါ။",
		},
	}, result.Error)
}

func TestParseConfig_BasicAccess(t *testing.T) {
	userInputConfig := `
transport:
  $type: basic-access
`
	result := doParseTunnelConfig(userInputConfig)
	require.Nil(t, result.Error, "doParseTunnelConfig failed: %v", result.Error)

	matchClientConfig(t, userInputConfig, result.Value)
}

// The tests below are to record broken usage of github.com/goccy/go-yaml.
// See https://github.com/OutlineFoundation/outline-apps/issues/2576.
// We can go back to using those functions if they get fixed.

func Test_Demonstrate_YAMLMarshal_IsBroken(t *testing.T) {
	// https://github.com/goccy/go-yaml/issues/781
	t.Skip("yaml.Marshal is broken")
	yamlBytes, err := yaml.Marshal("SSH-2.0\r\n")
	require.NoError(t, err)
	var target string
	require.NoError(t, yaml.Unmarshal(yamlBytes, &target))
	require.Equal(t, "SSH-2.0\r\n", target)
}

func Test_Demonstrate_ValueToNode_IsBroken(t *testing.T) {
	// https://github.com/goccy/go-yaml/issues/782
	t.Skip("yaml.ValueToNode is broken")
	yamlNode, err := yaml.ValueToNode("SECRET/!@#")
	require.NoError(t, err)
	stringNode, ok := yamlNode.(*ast.StringNode)
	require.True(t, ok)
	require.Equal(t, "SECRET/!@#", string(stringNode.Value))
}
