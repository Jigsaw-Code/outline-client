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

/**
 * @file Contains helper functions implemented in Go.
 * This file provides a communication channel between TypeScript and Go,
 * allowing users to call Go functions from TypeScript.
 */

import {pathToEmbeddedTun2socksBinary} from './app_paths';
import {ChildProcessHelper} from './process';

/**
 * Verifies the UDP connectivity of the server specified in `config`.
 * Checks whether proxy server is reachable, whether the network and proxy support UDP forwarding
 * and validates the proxy credentials.
 *
 * @param clientConfig The configuration to create the tunnel client.
 * @param debugMode Optional. Whether to forward logs to stdout. Defaults to false.
 * @returns A boolean indicating whether UDP forwarding is supported.
 * @throws Error if TCP connection cannot be established.
 * @throws ProcessTerminatedExitCodeError if tun2socks failed to run.
 */
export function checkUDPConnectivity(
  clientConfig: string,
  debugMode: boolean = false
): Promise<boolean> {
  return checkUDPConnectivityWithArgs(
    ['-client', clientConfig, '-checkConnectivity'],
    debugMode
  );
}

/**
 * Verifies the UDP connectivity of the server specified in `config`.
 * Checks whether proxy server is reachable, whether the network and proxy support UDP forwarding
 * and validates the proxy credentials.
 *
 * @param clientConfig The configuration to create the tunnel client.
 * @param adapterIndex Optional. Whether to use a specific network adapter for testing.
 * @param debugMode Optional. Whether to forward logs to stdout. Defaults to false.
 * @returns A boolean indicating whether UDP forwarding is supported.
 * @throws Error if TCP connection cannot be established.
 * @throws ProcessTerminatedExitCodeError if tun2socks failed to run.
 */
export function checkUDPConnectivityWindows(
  clientConfig: string,
  adapterIndex: string,
  debugMode: boolean = false
): Promise<boolean> {
  const args = ['-client', clientConfig, '-checkConnectivity'];
  if (adapterIndex) {
    args.push('-adapterIndex', adapterIndex);
  }
  return checkUDPConnectivityWithArgs(args, debugMode);
}

async function checkUDPConnectivityWithArgs(
  args: string[],
  debugMode: boolean
): Promise<boolean> {
  const tun2socks = new ChildProcessHelper(pathToEmbeddedTun2socksBinary());
  tun2socks.isDebugModeEnabled = debugMode;

  // The arguments contain the complete access-key configuration.
  console.debug('[tun2socks] - checking connectivity ...');
  const output = await tun2socks.launch(args);

  // Only parse the first line, because sometimes Windows Crypto API adds warnings to stdout.
  const outObj = JSON.parse(output.split('\n')[0]);
  if (outObj.tcp) {
    throw new Error(outObj.tcp);
  }
  if (outObj.udp) {
    return false;
  }
  return true;
}
