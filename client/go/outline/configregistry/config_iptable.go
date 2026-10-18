// Copyright 2025 The Outline Authors
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
	"errors"
	"fmt"
	"net/netip"

	"golang.getoutline.org/sdk/transport"

	"localhost/client/go/configyaml"
	"localhost/client/go/outline/iptable"
)

type ipTableRootConfig struct {
	Table    []ipTableEntryConfig  `yaml:"table"`
	Fallback configyaml.ConfigNode `yaml:"fallback,omitempty"`
}

type ipTableEntryConfig struct {
	IPs    []string              `yaml:"ips"`
	Dialer configyaml.ConfigNode `yaml:"dialer"`
}

func parseIPTableStreamDialer(
	ctx context.Context,
	configMap map[string]any,
	parseSD configyaml.ParseFunc[*Dialer[transport.StreamConn]],
) (*Dialer[transport.StreamConn], error) {
	var rootCfg ipTableRootConfig
	if err := configyaml.MapToAny(configMap, &rootCfg); err != nil {
		return nil, fmt.Errorf("failed to map iptable stream config: %w", err)
	}

	if len(rootCfg.Table) == 0 {
		return nil, errors.New("iptable config 'table' must not be empty for stream dialer")
	}

	allConnTunnelled := true
	allConnDirect := true
	allConnBlocked := true

	dialerTable := iptable.NewIPTable[transport.StreamDialer]()
	for i, entryCfg := range rootCfg.Table {
		if entryCfg.Dialer == nil {
			return nil, fmt.Errorf("iptable entry %d has no dialer specified", i)
		}

		parsedSubDialer, err := parseSD(ctx, entryCfg.Dialer)

		if err != nil {
			return nil, fmt.Errorf("failed to parse nested stream dialer for table entry %d: %w", i, err)
		}

		if parsedSubDialer.ConnType != ConnTypeBlocked {
			allConnBlocked = false
			if parsedSubDialer.ConnType != ConnTypeTunneled {
				allConnTunnelled = false
			}
			if parsedSubDialer.ConnType != ConnTypeDirect {
				allConnDirect = false
			}
		}

		ipsDialer := transport.FuncStreamDialer(parsedSubDialer.Dial)

		for _, ip := range entryCfg.IPs {
			var currentPrefix netip.Prefix
			parsedPrefix, errPrefix := netip.ParsePrefix(ip)
			if errPrefix == nil {
				currentPrefix = parsedPrefix
			} else {
				addr, errAddr := netip.ParseAddr(ip)
				if errAddr != nil {
					return nil, fmt.Errorf("iptable entry %d IP '%s' is not a valid IP address or CIDR prefix: failed to parse as prefix (%v) and failed to parse as address (%v)", i, ip, errPrefix, errAddr)
				}
				currentPrefix = netip.PrefixFrom(addr, addr.BitLen())
			}

			dialerTable.AddPrefix(currentPrefix, ipsDialer)
		}
	}

	var fallbackDialer transport.StreamDialer
	fallbackFirstHop := ""
	if rootCfg.Fallback != nil {
		parsedFallbackDialer, err := parseSD(ctx, rootCfg.Fallback)

		if err != nil {
			return nil, fmt.Errorf("failed to parse nested stream dialer fallback: %w", err)
		}
		fallbackFirstHop = parsedFallbackDialer.ConnectionProviderInfo.FirstHop
		if parsedFallbackDialer.ConnType != ConnTypeBlocked {
			allConnBlocked = false
			if parsedFallbackDialer.ConnType != ConnTypeTunneled {
				allConnTunnelled = false
			}
			if parsedFallbackDialer.ConnType != ConnTypeDirect {
				allConnDirect = false
			}
		}

		fallbackDialer = transport.FuncStreamDialer(parsedFallbackDialer.Dial)
	}

	dialer, err := iptable.NewStreamDialer(dialerTable, fallbackDialer)

	if err != nil {
		return nil, fmt.Errorf("failed to create IPTableStreamDialer: %w", err)
	}

	var connType ConnType
	if allConnBlocked {
		connType = ConnTypeBlocked
	} else if allConnDirect && allConnTunnelled {
		// These should never happen because we require len(rootCfg.Table) != 0
		return nil, fmt.Errorf("allConnDirect, allConnTunnelled cannot all be true")
	} else if allConnTunnelled {
		connType = ConnTypeTunneled
	} else if allConnDirect {
		connType = ConnTypeDirect
	} else {
		connType = ConnTypePartial
	}

	return &Dialer[transport.StreamConn]{
		Dial: dialer.DialStream,
		ConnectionProviderInfo: ConnectionProviderInfo{
			ConnType: connType,
			FirstHop: fallbackFirstHop,
		},
	}, nil
}

func NewIPTableStreamDialerSubParser(parseSD configyaml.ParseFunc[*Dialer[transport.StreamConn]]) func(ctx context.Context, input map[string]any) (*Dialer[transport.StreamConn], error) {
	return func(ctx context.Context, input map[string]any) (*Dialer[transport.StreamConn], error) {
		return parseIPTableStreamDialer(ctx, input, parseSD)
	}
}
