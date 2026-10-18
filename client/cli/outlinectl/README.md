# macOS command line control

`outlinectl` sends local commands to the running macOS Outline app. It uses the
same saved servers, Network Extension, and connection state as the GUI. It does
not need access keys or run a second VPN process.

Build on macOS from the repository root:

```sh
go build -o outlinectl ./client/cli/outlinectl
```

This requires a macOS Outline build containing the local command bridge. The
app must be running. Examples:

```sh
./outlinectl status
./outlinectl servers
./outlinectl --server Singapore connect
./outlinectl --server Frankfurt reconnect
./outlinectl disconnect
```

`--server` accepts an exact saved name or server ID. A name shared by multiple
servers is ambiguous; use an ID from `servers`. Flags come before the command.
Responses are JSON; exit status is 0 on success, 1 on failure or unknown
outcome, and 2 for invalid arguments. After a timeout, inspect `status` before
retrying a mutation.

Automation can recover a stalled tunnel with an expected active server ID:

```sh
./outlinectl --server Frankfurt --expect-active CURRENT_ID recover
```

`recover` requires the user's connection intent to remain on and the selected
server to match `CURRENT_ID` when the command runs. An explicit GUI or CLI
disconnect leaves the VPN off and suppresses automatic recovery. The command
does not monitor connectivity by itself; callers decide when to invoke it.

The app listens on a mode-0600 Unix socket inside its sandbox:

```
~/Library/Containers/org.outline.macos.client/Data/.outline-cli/control.sock
```

The socket's parent directory is mode 0700, and the app checks that peers use
the same macOS user ID. No TCP port or URL command handler is exposed.
Processes running as the same user are trusted to control the VPN. For a custom
bundle ID, pass `--socket` with that app's sandbox socket path.

## Domain exclusions

On the Apple client, the **Domain exclusions** menu page and CLI edit the same
local policy for all servers. Disconnect manually before saving; the next
connection applies the new list. Provider access keys cannot change this policy.

```sh
outlinectl exclusions
outlinectl disconnect
outlinectl --domains 'ab.chatgpt.com,example.com' set-exclusions
outlinectl --server Singapore connect
# Clear all rules while disconnected:
outlinectl --domains '' set-exclusions
```

Up to 100 exact hostnames are supported; subdomains must be listed separately.
The response includes `canSave` and the normalized saved `domains`. Excluded
traffic uses the regular connection and public IP. Applications using private
secure DNS or cached real addresses may not use the exclusions. See
[the routing design](../../go/outline/domainbypass/README.md) for details.
