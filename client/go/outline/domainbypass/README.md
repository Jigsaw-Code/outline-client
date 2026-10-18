# Exact domain exclusions (Apple packet tunnel)

Device-owned settings are kept outside access keys. The UI accepts up to 100
exact hostnames (Unicode names are normalized to IDNA). Empty lists are the
default. Rules apply to all saved servers. Saving requires a manually disconnected
tunnel and takes effect on the next connection, including an OS-initiated start.

The packet tunnel intercepts its existing synthetic DNS resolver over UDP and
TCP. An excluded hostname receives a synthetic IPv4 address in `198.18.0.0/16`.
Its TCP and UDP flows are resolved and dialed directly by the Network Extension,
whose sockets are outside its own tunnel. The Apple settings include a host route
for the link-local resolver and explicit DNS matches for selected domains, so
another VPN’s catch-all resolver cannot hide the rules. IPv4-mapped IPv6
destinations are normalized before matching. Other DNS questions and destinations
keep the original proxy transport, including its UDP connectivity fallback.
Direct DNS uses Cloudflare (`1.1.1.1:53`) through the extension's direct sockets;
a failed lookup fails the connection, rather than falling back to another route.

Addresses are allocated from a persistent, append-only hostname registry, capped
at 4,096 historical names. Removing a rule never reassigns its address. Cached
TCP connections to a removed name go through the proxy; cached UDP flows are
rejected until a fresh DNS lookup obtains the ordinary address. Active flows end
when the user disconnects before editing. DNS answers have a one-second TTL.
Unknown synthetic addresses are rejected. The more-specific included `/16`
route must override Outline's existing excluded `198.18.0.0/15` range.

AAAA and HTTPS/SVCB queries for excluded names receive NODATA, avoiding real IP
hints that could skip the synthetic mapping. The outbound connection can still
use IPv6. This is hostname-based routing, not per-IP bypass: unrelated hosts on
a shared CDN address remain tunneled.

## Scope and limits

- Implemented in the Apple packet-tunnel client; macOS is the verified platform.
  Android and Electron do not expose the setting or receive the local policy.
- Exact names only, no wildcard or automatic subdomain expansion.
- Apps must use the system DNS resolver. Private DoH/DoT, hard-coded IPs, and
  previously cached real IPs remain on their normal route. Restart affected apps
  after changing rules. An exclusion is not a guarantee for every app protocol.
- Synthetic DNS is incompatible with clients insisting on end-to-end DNSSEC
  validation. No authenticated-data flag is asserted.
- Direct traffic and its DNS resolution expose the regular connection's public
  IP. A user must explicitly list a hostname; provider configuration cannot add
  exclusions. No domain or credential is logged by this implementation.
- The registry persists deleted names locally to prevent stale-address reuse.
  Reaching the historical limit returns an error instead of recycling addresses.
- Do not reuse this router on another OS without protected direct TCP/UDP sockets,
  a direct resolver, and an included route for its synthetic address space.

## Local verification

Go race-enabled existing Outline/configregistry checks, `go vet`, and a temporary
socket harness cover rule normalization, invalid input, DNS over TCP and UDP,
AAAA/HTTPS handling, exact matching, direct TCP dispatch, direct UDP echo,
removed-rule behavior, unknown synthetic addresses, and concurrent send/close.
The UI is type-checked, linted, built and visually inspected with a browser
fixture. Native compilation and signing are checked separately from live VPN
routing. Live VPN verification must confirm both excluded and ordinary egress before release.

Live macOS verification passed with a concurrent Tailscale tunnel: system DNS
and DNS over TCP/UDP return synthetic addresses for selected names, excluded
HTTPS uses the regular public IP, ordinary HTTPS uses the VPN exit, and removing
a rule sends both fresh and cached TCP destinations back through the proxy.
The Chrome automation initialization also succeeded with the VPN enabled and
the target domain excluded. Installed native UI interaction remains unverified.
