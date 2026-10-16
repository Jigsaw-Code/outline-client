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
	"errors"
	"fmt"
	"net/netip"

	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
	"localhost/client/go/composer/netconfig"
	"localhost/client/go/outline/iptable"
)

type IPTableEntryConfig struct {
	Prefixes []netip.Prefix
	Dialer   netconfig.StreamDialerConfig
}

// IPTableStreamDialerConfig routes by destination IP prefix.
type IPTableStreamDialerConfig struct {
	Entries []IPTableEntryConfig
	// Fallback dials addresses no entry matches. nil means there is no
	// fallback, so those addresses fail; both NewStreamDialer and the metadata
	// callback branch on it. Assign only an untyped nil — a typed nil pointer
	// makes this interface non-nil and defeats those checks.
	Fallback netconfig.StreamDialerConfig
}

func (c *IPTableStreamDialerConfig) NewStreamDialer(ctx context.Context) (transport.StreamDialer, error) {
	table := iptable.NewIPTable[transport.StreamDialer]()
	for _, entry := range c.Entries {
		dialer, err := entry.Dialer.NewStreamDialer(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to build iptable entry dialer: %w", err)
		}
		for _, prefix := range entry.Prefixes {
			table.AddPrefix(prefix, dialer)
		}
	}
	var fallback transport.StreamDialer
	if c.Fallback != nil {
		var err error
		fallback, err = c.Fallback.NewStreamDialer(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to build iptable fallback dialer: %w", err)
		}
	}
	return iptable.NewStreamDialer(table, fallback)
}

type ipTableEntryFields struct {
	IPs    []string
	Dialer composer.Node
}

type ipTableFields struct {
	Table    []ipTableEntryFields
	Fallback composer.Optional[composer.Node]
}

func newIPTableParser(parseSD composer.ParseFunc[netconfig.StreamDialerConfig]) composer.ParseFunc[*IPTableStreamDialerConfig] {
	return func(ctx context.Context, node composer.Node) (*IPTableStreamDialerConfig, error) {
		var fields ipTableFields
		if err := node.Decode(&fields); err != nil {
			return nil, fmt.Errorf("failed to decode iptable config: %w", err)
		}
		if len(fields.Table) == 0 {
			return nil, errors.New("iptable config 'table' must not be empty")
		}
		cfg := &IPTableStreamDialerConfig{}
		for i, entry := range fields.Table {
			if entry.Dialer.IsAbsent() {
				return nil, fmt.Errorf("iptable entry %d has no dialer specified", i)
			}
			dialer, err := parseSD(ctx, entry.Dialer)
			if err != nil {
				return nil, fmt.Errorf("failed to parse dialer for table entry %d: %w", i, err)
			}
			parsed := IPTableEntryConfig{Dialer: dialer}
			for _, text := range entry.IPs {
				prefix, err := netip.ParsePrefix(text)
				if err != nil {
					addr, addrErr := netip.ParseAddr(text)
					if addrErr != nil {
						return nil, fmt.Errorf("iptable entry %d IP %q is not a valid IP address or CIDR prefix", i, text)
					}
					prefix = netip.PrefixFrom(addr, addr.BitLen())
				}
				parsed.Prefixes = append(parsed.Prefixes, prefix)
			}
			cfg.Entries = append(cfg.Entries, parsed)
		}
		if fallbackNode, ok := fields.Fallback.Get(); ok {
			fallback, err := parseSD(ctx, fallbackNode)
			if err != nil {
				return nil, fmt.Errorf("failed to parse fallback dialer: %w", err)
			}
			cfg.Fallback = fallback
		}
		return cfg, nil
	}
}
