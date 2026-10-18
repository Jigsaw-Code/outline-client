// Copyright 2026 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// outlinectl talks to the macOS Outline app's local command bridge.
// It never reads access keys or configures a separate VPN.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func run() int {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Cannot find home directory")
		return 1
	}
	flags := flag.NewFlagSet("outlinectl", flag.ContinueOnError)
	socket := flags.String("socket", filepath.Join(home, "Library/Containers/org.outline.macos.client/Data/.outline-cli/control.sock"), "Outline app's Unix socket")
	server := flags.String("server", "", "exact saved server name or ID")
	domains := flags.String("domains", "", "comma-separated exact domains for set-exclusions; empty clears the list")
	expected := flags.String("expect-active", "", "required current server ID for watchdog recovery")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "Usage: outlinectl [flags] status|servers|connect|disconnect|reconnect|recover|exclusions|set-exclusions\nFlags must precede the command. connect/reconnect require --server.\nrecover requires --server and --expect-active and respects manual disconnection.")
		flags.PrintDefaults()
	}
	if err := flags.Parse(os.Args[1:]); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if flags.NArg() != 1 {
		flags.Usage()
		return 2
	}
	action := flags.Arg(0)
	switch action {
	case "status", "servers", "disconnect", "exclusions", "set-exclusions":
		if *server != "" || *expected != "" {
			fmt.Fprintln(os.Stderr, "This command takes no server flags")
			return 2
		}
	case "connect", "reconnect":
		if *server == "" || *expected != "" {
			fmt.Fprintln(os.Stderr, "Specify --server only")
			return 2
		}
	case "recover":
		if *server == "" || *expected == "" {
			fmt.Fprintln(os.Stderr, "Recovery requires --server and --expect-active")
			return 2
		}
	default:
		flags.Usage()
		return 2
	}
	domainsProvided := false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "domains" {
			domainsProvided = true
		}
	})
	if domainsProvided != (action == "set-exclusions") {
		fmt.Fprintln(os.Stderr, "Use --domains only with set-exclusions (empty clears the list)")
		return 2
	}
	if len(*server) > 256 || len(*expected) > 256 {
		fmt.Fprintln(os.Stderr, "Server identifier too long")
		return 2
	}
	request := map[string]any{"v": 1, "action": action, "server": *server, "expected": *expected}
	if action == "set-exclusions" {
		entries := []string{}
		if *domains != "" {
			entries = strings.Split(*domains, ",")
		}
		if len(entries) > 100 {
			fmt.Fprintln(os.Stderr, "At most 100 domains")
			return 2
		}
		for _, entry := range entries {
			if len(entry) > 253 {
				fmt.Fprintln(os.Stderr, "Domain too long")
				return 2
			}
		}
		request["domains"] = entries
	}
	conn, err := net.DialTimeout("unix", *socket, 3*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Cannot reach the Outline command bridge. Install and run a compatible macOS Outline app. No VPN changes made.")
		return 1
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(125 * time.Second)); err != nil {
		return 1
	}
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		fmt.Fprintln(os.Stderr, "Cannot send command")
		return 1
	}
	response, err := bufio.NewReader(io.LimitReader(conn, 65537)).ReadBytes('\n')
	if err != nil || len(response) > 65536 {
		fmt.Fprintln(os.Stderr, "No valid reply. Outcome unknown; inspect status before retrying.")
		return 1
	}
	var result struct {
		OK *bool `json:"ok"`
	}
	if json.Unmarshal(response, &result) != nil || result.OK == nil {
		fmt.Fprintln(os.Stderr, "Invalid bridge response")
		return 1
	}
	if _, err := os.Stdout.Write(response); err != nil {
		return 1
	}
	if !*result.OK {
		return 1
	}
	return 0
}

func main() { os.Exit(run()) }
