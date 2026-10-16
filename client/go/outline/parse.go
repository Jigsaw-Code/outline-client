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
	"fmt"
	"strings"

	"localhost/client/go/outline/configregistry"
	"localhost/client/go/outline/platerrors"

	"github.com/goccy/go-yaml"
)

// providerConfig is the config fetched from the provider. It may contain either an error or a tunnel config.
// Only the Error field is read (see doParseTunnelConfig); goccy ignores
// unknown fields (e.g. transport) by default.
type providerConfig struct {
	ProviderErrorConfig `yaml:",inline"`
}

// ProviderErrorConfig is config returned by the provider with a custom error to
// show to the user.
type ProviderErrorConfig struct {
	Error *struct {
		Message string
		Details string
	}
}

// firstHopAndTunnelConfigJSON must match FirstHopAndTunnelConfigJson in config.ts.
type firstHopAndTunnelConfigJSON struct {
	Client string `json:"client"`
	// FirstHop is the address the client will dial. On platforms where the
	// analyzer resolves direct addresses it is an IP, so a VPN can install a
	// bypass route covering exactly that address. Note Client keeps the config
	// as written, so the stored access key is unaffected.
	FirstHop       string                  `json:"firstHop"`
	ConnectionType configregistry.ConnType `json:"connectionType"`
}

func hasKey[K comparable, V any](m map[K]V, key K) bool {
	_, ok := m[key]
	return ok
}

func combinedConnectionType(streamConnType, packetConnType configregistry.ConnType) configregistry.ConnType {
	// When one connection is blocked is always the other connection type
	if streamConnType == configregistry.ConnTypeBlocked {
		return packetConnType
	}
	if packetConnType == configregistry.ConnTypeBlocked {
		return streamConnType
	}

	// Matching connection type
	if streamConnType == packetConnType {
		return streamConnType
	}

	// Connections are non-matching and not blocked
	return configregistry.ConnTypePartial
}

func doParseTunnelConfig(input string) *InvokeMethodResult {
	input = strings.TrimSpace(input)
	// Input may be one of:
	// - ss:// link
	// - Legacy Shadowsocks JSON (parsed as YAML)
	// - Advanced YAML format
	var stringValue string
	var clientConfigMap map[string]any
	if err := yaml.Unmarshal([]byte(input), &stringValue); err == nil {
		// Legacy URL format. Input is the transport config.
		clientConfigMap = map[string]any{"transport": stringValue}
	} else {
		var yamlValue map[string]any
		if err := yaml.Unmarshal([]byte(input), &yamlValue); err != nil {
			return &InvokeMethodResult{
				Error: &platerrors.PlatformError{
					Code:    platerrors.InvalidConfig,
					Message: fmt.Sprintf("failed to parse: %s", err),
				},
			}
		}

		if hasKey(yamlValue, "transport") || hasKey(yamlValue, "error") {
			// New format. Parse as tunnel config
			providerConfig := providerConfig{}
			if err := yaml.Unmarshal([]byte(input), &providerConfig); err != nil {
				return &InvokeMethodResult{
					Error: &platerrors.PlatformError{
						Code:    platerrors.InvalidConfig,
						Message: fmt.Sprintf("failed to parse: %s", err),
					},
				}
			}

			// Process provider error, if present.
			if providerConfig.Error != nil {
				platErr := &platerrors.PlatformError{
					Code:    platerrors.ProviderError,
					Message: providerConfig.Error.Message,
				}
				if providerConfig.Error.Details != "" {
					platErr.Details = map[string]any{
						"details": providerConfig.Error.Details,
					}
				}
				return &InvokeMethodResult{Error: platErr}
			}

			// Extract the client config.
			clientConfigMap = yamlValue
		} else {
			// Legacy JSON format. Input is the transport config.
			clientConfigMap = map[string]any{"transport": yamlValue}
		}
	}

	// Use JSON marshaling from the standard library because the YAML library is buggy.
	// See https://github.com/OutlineFoundation/outline-apps/issues/2576.
	// JSON is a subset of YAML, so that's valid YAML.
	clientConfigBytes, err := json.Marshal(clientConfigMap)
	if err != nil {
		return &InvokeMethodResult{
			Error: &platerrors.PlatformError{
				Code:    platerrors.InvalidConfig,
				Message: fmt.Sprintf("failed to normalize config: %s", err),
			},
		}
	}

	parsed, err := (&ClientParser{
		DataDir: GetBackendConfig().DataDir,
	}).Parse("", string(clientConfigBytes))
	if err != nil {
		return &InvokeMethodResult{Error: platerrors.ToPlatformError(err)}
	}
	response := firstHopAndTunnelConfigJSON{
		Client: string(clientConfigBytes),
	}
	if parsed.Info.Stream.FirstHop == parsed.Info.Packet.FirstHop {
		response.FirstHop = parsed.Info.Stream.FirstHop
	}
	response.ConnectionType = combinedConnectionType(parsed.Info.Stream.ConnType, parsed.Info.Packet.ConnType)

	responseBytes, err := json.Marshal(response)
	if err != nil {
		return &InvokeMethodResult{
			Error: &platerrors.PlatformError{
				Code:    platerrors.InternalError,
				Message: fmt.Sprintf("failed to serialize JSON response: %v", err),
			},
		}
	}

	return &InvokeMethodResult{
		Value: string(responseBytes),
	}
}
