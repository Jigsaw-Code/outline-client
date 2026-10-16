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
	"encoding/json"
)

// ConnType is the type of the connections returned by dialers and endpoints.
type ConnType int

const (
	ConnTypeDirect ConnType = iota
	ConnTypeTunneled
	ConnTypePartial
	ConnTypeBlocked
)

// MarshalJSON keeps ConnType's Go-to-TypeScript wire representation in sync
// with client/web/app/outline_server_repository/config.ts#ConnectionType.
func (c ConnType) MarshalJSON() ([]byte, error) {
	var value string
	switch c {
	case ConnTypeDirect:
		value = "direct"
	case ConnTypeTunneled:
		value = "tunneled"
	case ConnTypePartial:
		value = "partial"
	case ConnTypeBlocked:
		value = "blocked"
	default:
		return nil, &json.UnsupportedValueError{Str: "invalid ConnType"}
	}
	return json.Marshal(value)
}

// ConnectionProviderInfo describes the connections created by a dialer or
// endpoint.
type ConnectionProviderInfo struct {
	ConnType ConnType
	// FirstHop is the address the first hop will be dialed at. On platforms
	// where Outline resolves direct addresses during parsing it is an IP, so a
	// VPN can install a bypass route that covers exactly the address we dial; it
	// is the address from the config otherwise.
	FirstHop string
}

// TransportPairInfo describes both halves of a transport config.
type TransportPairInfo struct {
	Stream ConnectionProviderInfo
	Packet ConnectionProviderInfo
}
