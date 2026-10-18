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

// Package domainbypass implements opt-in, exact-hostname routing for Apple's
// packet tunnel. Synthetic DNS addresses avoid bypassing unrelated CDN tenants.
// Callers must route 198.18.0.0/16 into the tunnel and supply direct dialers whose
// sockets and DNS lookups escape the tunnel. Never enable this on other platforms
// without providing equivalent socket protection.
package domainbypass

import (
	"encoding/json"
	"errors"
	"net/netip"
	"strings"

	"golang.org/x/net/idna"
)

// Config is device-owned, never part of a provider's access-key configuration.
// KnownDomains is append-only: cached addresses must never identify another host.
type Config struct {
	Domains      []string `json:"domains"`
	KnownDomains []string `json:"knownDomains"`
}

func Parse(text string) (Config, error) {
	c := Config{Domains: []string{}, KnownDomains: []string{}}
	if text == "" {
		return c, nil
	}
	if len(text) > 1048576 {
		return c, errors.New("domain exclusions are too large")
	}
	if err := json.Unmarshal([]byte(text), &c); err != nil {
		return c, errors.New("invalid domain exclusions")
	}
	if len(c.Domains) > 100 || len(c.KnownDomains) > 4096 {
		return c, errors.New("domain exclusion limit reached")
	}
	known := map[string]bool{}
	for _, d := range c.KnownDomains {
		normalized, err := normalize(d)
		if err != nil || d != normalized || known[d] {
			return c, errors.New("invalid saved domain registry")
		}
		known[d] = true
	}
	active := []string{}
	seen := map[string]bool{}
	for _, d := range c.Domains {
		d, err := normalize(d)
		if err != nil {
			return c, err
		}
		if seen[d] {
			continue
		}
		seen[d] = true
		active = append(active, d)
		if !known[d] {
			if len(c.KnownDomains) >= 4096 {
				return c, errors.New("domain registry is full")
			}
			c.KnownDomains = append(c.KnownDomains, d)
			known[d] = true
		}
	}
	c.Domains = active
	if c.KnownDomains == nil {
		c.KnownDomains = []string{}
	}
	return c, nil
}

func normalize(input string) (string, error) {
	d, err := idna.Lookup.ToASCII(strings.TrimSuffix(strings.ToLower(strings.TrimSpace(input)), "."))
	invalid := errors.New("enter exact domain names, without URLs, IP addresses or wildcards")
	if err != nil || len(d) > 253 || !strings.Contains(d, ".") {
		return "", invalid
	}
	if _, err := netip.ParseAddr(d); err == nil {
		return "", invalid
	}
	labels := strings.Split(d, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", invalid
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
				return "", invalid
			}
		}
	}
	numeric := true
	for _, ch := range labels[len(labels)-1] {
		if ch < '0' || ch > '9' {
			numeric = false
		}
	}
	if numeric {
		return "", invalid
	}
	return d, nil
}
