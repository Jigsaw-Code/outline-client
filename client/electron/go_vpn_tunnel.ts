// Copyright 2021 The Outline Authors
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

import {platform} from 'os';

import {powerMonitor} from 'electron';

import {pathToEmbeddedTun2socksBinary} from './app_paths';
import {checkUDPConnectivity, checkUDPConnectivityWindows} from './go_helpers';
import {ChildProcessHelper, ProcessTerminatedSignalError} from './process';
import {RoutingDaemon} from './routing_service';
import {VpnTunnel} from './vpn_tunnel';
import {TunnelStatus} from '../web/app/outline_server_repository/vpn';

const IS_LINUX = platform() === 'linux';
const IS_WINDOWS = platform() === 'win32';

const TUN2SOCKS_TAP_DEVICE_NAME = IS_LINUX ? 'outline-tun0' : 'outline-tap0';
const TUN2SOCKS_TAP_DEVICE_IP = '10.0.85.2';
const TUN2SOCKS_VIRTUAL_ROUTER_IP = '10.0.85.1';
const TUN2SOCKS_VIRTUAL_ROUTER_NETMASK = '255.255.255.0';

// Cloudflare and Quad9 resolvers.
const DNS_RESOLVERS = ['1.1.1.1', '9.9.9.9'];

// Establishes a full-system VPN with the help of Outline's routing daemon and child process
// outline-go-tun2socks. The routing service modifies the routing table so that the TAP device
// receives all device traffic. outline-go-tun2socks process TCP and UDP traffic from the TAP
// device and relays it to an Outline proxy server.
//
// |TAP| <-> |outline-go-tun2socks| <-> |Outline proxy|
//
// In addition to the basic lifecycle of the helper processes, this class restarts tun2socks
// on unexpected failures and network changes if necessary.
// Follows the Mediator pattern in that none of the "helpers" know anything
// about the others.
export class GoVpnTunnel implements VpnTunnel {
  private readonly tun2socks: GoTun2socks;
  private isDebugMode = false;

  // See #resumeListener.
  private disconnected = false;

  private isUdpEnabled = false;
  private gatewayAdapterIndex?: string;

  private readonly onAllHelpersStopped: Promise<void>;
  private resolveAllHelpersStopped: () => void;

  private reconnectingListener?: () => void;

  private reconnectedListener?: () => void;

  // Serializes tun2socks restarts. Network change and resume events can fire in rapid
  // succession; running restarts concurrently would race on launching the tun2socks process.
  private restartInFlight?: Promise<void>;
  private restartPending = false;

  constructor(
    private readonly routing: RoutingDaemon,
    readonly keyId: string,
    readonly clientConfig: string
  ) {
    this.tun2socks = new GoTun2socks(keyId);

    // This promise, tied to both helper process' exits, is key to the instance's
    // lifecycle:
    //  - once any helper fails or exits, stop them all
    //  - once *all* helpers have stopped, we're done
    this.onAllHelpersStopped = new Promise(resolve => {
      this.resolveAllHelpersStopped = resolve;
    });

    // Handle network changes and, on Windows, suspend events.
    this.routing.onNetworkChange = this.networkChanged.bind(this);
  }

  // Turns on verbose logging for the managed processes. Must be called before launching the
  // processes
  enableDebugMode() {
    this.isDebugMode = true;
    this.tun2socks.enableDebugMode();
  }

  // Fulfills once all three helpers have started successfully.
  async connect(checkProxyConnectivity: boolean) {
    if (IS_WINDOWS) {
      // Windows: when the system suspends, tun2socks terminates due to the TAP device getting
      // closed.
      powerMonitor.on('suspend', this.suspendListener.bind(this));
      powerMonitor.on('resume', this.resumeListener.bind(this));
    }

    // Disconnect the tunnel if the routing service disconnects unexpectedly.
    this.routing.onceDisconnected
      .then(async () => {
        await this.disconnect();
      })
      .catch(e => {
        console.error('error in routing service disconnection:', e);
      });

    if (checkProxyConnectivity) {
      if (IS_WINDOWS) {
        this.isUdpEnabled = await checkUDPConnectivityWindows(
          this.clientConfig,
          this.gatewayAdapterIndex,
          this.isDebugMode
        );
      } else {
        this.isUdpEnabled = await checkUDPConnectivity(
          this.clientConfig,
          this.isDebugMode
        );
      }
    }
    console.log(`UDP support: ${this.isUdpEnabled}`);

    console.log('starting routing daemon');
    this.gatewayAdapterIndex = await this.routing.start();
    await this.startTun2socks();
  }

  networkChanged(status: TunnelStatus, gatewayIndex?: string) {
    if (this.disconnected) {
      return;
    }
    if (status === TunnelStatus.CONNECTED) {
      if (gatewayIndex) {
        this.gatewayAdapterIndex = gatewayIndex;
      }
      if (this.reconnectedListener) {
        this.reconnectedListener();
      }

      // Test whether UDP availability has changed; since it won't change 99% of the time, do this
      // *after* we've informed the client we've reconnected.
      this.updateUdpAndRestartTun2socks().catch(e => {
        console.error('failed to restart tun2socks after network change:', e);
      });
    } else if (status === TunnelStatus.RECONNECTING) {
      if (this.reconnectingListener) {
        this.reconnectingListener();
      }
    } else {
      console.error(
        `unknown network change status ${status} from routing daemon`
      );
    }
  }

  private async suspendListener() {
    // Preemptively stop tun2socks to avoid a silent restart that will fail.
    await this.tun2socks.stop();
    console.log('stopped tun2socks in preparation for suspend');
  }

  private async resumeListener() {
    if (this.disconnected) {
      // NOTE: Cannot remove resume listeners - Electron bug?
      console.error(
        'resume event invoked but this tunnel is terminated - doing nothing'
      );
      return;
    }

    console.log('restarting tun2socks after resume');
    await this.updateUdpAndRestartTun2socks();
  }

  private startTun2socks(): Promise<void> {
    if (IS_WINDOWS) {
      return this.tun2socks.startWindows(
        this.clientConfig,
        this.isUdpEnabled,
        this.gatewayAdapterIndex
      );
    } else {
      return this.tun2socks.start(this.clientConfig, this.isUdpEnabled);
    }
  }

  // Coalesces concurrent restart requests: if a restart is already running, the request is
  // recorded and a single follow-up restart is performed once the current one completes.
  private updateUdpAndRestartTun2socks(): Promise<void> {
    if (this.restartInFlight) {
      this.restartPending = true;
      return this.restartInFlight;
    }
    this.restartInFlight = (async () => {
      try {
        let lastError: unknown = undefined;
        do {
          this.restartPending = false;
          if (this.disconnected) {
            return;
          }
          try {
            lastError = undefined;
            await this.doUpdateUdpAndRestartTun2socks();
          } catch (e) {
            // Don't drop a restart requested while this attempt was running: if one is
            // pending, try again; otherwise surface the failure to the caller.
            lastError = e;
            if (this.restartPending) {
              console.error(
                'tun2socks restart failed; retrying pending restart:',
                e
              );
            }
          }
        } while (this.restartPending);
        if (lastError !== undefined) {
          throw lastError;
        }
      } finally {
        this.restartPending = false;
        this.restartInFlight = undefined;
      }
    })();
    return this.restartInFlight;
  }

  private async doUpdateUdpAndRestartTun2socks() {
    try {
      if (IS_WINDOWS) {
        this.isUdpEnabled = await checkUDPConnectivityWindows(
          this.clientConfig,
          this.gatewayAdapterIndex,
          this.isDebugMode
        );
      } else {
        this.isUdpEnabled = await checkUDPConnectivity(
          this.clientConfig,
          this.isDebugMode
        );
      }
      console.log(`UDP support now ${this.isUdpEnabled}`);
    } catch (e) {
      console.error('connectivity check failed:', e);
    }

    // Restart tun2socks.
    try {
      await this.tun2socks.stop();
    } catch {
      // Ignore the errors
    }
    await this.startTun2socks();
  }

  // Use #onceDisconnected to be notified when the tunnel terminates.
  async disconnect() {
    if (this.disconnected) {
      return;
    }

    if (IS_WINDOWS) {
      powerMonitor.removeListener('suspend', this.suspendListener.bind(this));
      powerMonitor.removeListener('resume', this.resumeListener.bind(this));
    }

    try {
      await this.tun2socks.stop();
    } catch (e) {
      if (!(e instanceof ProcessTerminatedSignalError)) {
        console.error(`could not stop tun2socks: ${e.message}`);
      }
    }

    try {
      await this.routing.stop();
    } catch (e) {
      // This can happen for several reasons, e.g. the daemon may have stopped while we were
      // connected.
      console.error(`could not stop routing: ${e.message}`);
    }
    this.resolveAllHelpersStopped();
    this.disconnected = true;
  }

  // Fulfills once all helper processes have stopped.
  //
  // When this happens, *as many changes made to the system in order to establish the full-system
  // VPN as possible* will have been reverted.
  get onceDisconnected() {
    return this.onAllHelpersStopped;
  }

  // Sets an optional callback for when the routing daemon is attempting to re-connect.
  onReconnecting(newListener: () => void | undefined) {
    this.reconnectingListener = newListener;
  }

  // Sets an optional callback for when the routing daemon successfully reconnects.
  onReconnected(newListener: () => void | undefined) {
    this.reconnectedListener = newListener;
  }
}

// outline-go-tun2socks is a Go program that processes IP traffic from a TUN/TAP device
// and relays it to a Outline proxy server.
class GoTun2socks {
  // Resolved when Tun2socks prints "tun2socks running" to stdout
  // Call `monitorStarted` to set this field
  private whenStarted: Promise<void>;
  private stopRequested = false;
  private readonly process: ChildProcessHelper;

  constructor(readonly keyId: string) {
    this.process = new ChildProcessHelper(pathToEmbeddedTun2socksBinary());
  }

  /**
   * Starts tun2socks process, and waits for it to launch successfully.
   * Success is confirmed when the phrase "tun2socks running" is detected in the `stdout`.
   * Otherwise, an error containing a JSON-formatted message will be thrown.
   * @param isUdpEnabled Indicates whether the remote Outline server supports UDP.
   */
  start(clientConfig: string, isUdpEnabled: boolean): Promise<void> {
    return this.startWithPlatformSpecificArgs(clientConfig, isUdpEnabled, []);
  }

  /**
   * Starts tun2socks process with Windows specific CLI arguments.
   */
  startWindows(
    clientConfig: string,
    isUdpEnabled: boolean,
    adapterIndex?: string
  ): Promise<void> {
    const args: string[] = [];
    if (adapterIndex) {
      args.push('-adapterIndex', adapterIndex);
    }
    return this.startWithPlatformSpecificArgs(clientConfig, isUdpEnabled, args);
  }

  private startWithPlatformSpecificArgs(
    clientConfig: string,
    isUdpEnabled: boolean,
    args: string[]
  ): Promise<void> {
    // ./tun2socks.exe \
    //   -tunName outline-tap0 -tunDNS 1.1.1.1,9.9.9.9 \
    //   -tunAddr 10.0.85.2 -tunGw 10.0.85.1 -tunMask 255.255.255.0 \
    //   -client '{ "transport:" {"host": "127.0.0.1", "port": 1080, "password": "mypassword", "cipher": "chacha20-ietf-poly1035"} }' \
    //   [-dnsFallback] [-checkConnectivity] [-proxyPrefix]

    args.push('-keyID', this.keyId);
    args.push('-tunName', TUN2SOCKS_TAP_DEVICE_NAME);
    args.push('-tunAddr', TUN2SOCKS_TAP_DEVICE_IP);
    args.push('-tunGw', TUN2SOCKS_VIRTUAL_ROUTER_IP);
    args.push('-tunMask', TUN2SOCKS_VIRTUAL_ROUTER_NETMASK);
    args.push('-tunDNS', DNS_RESOLVERS.join(','));
    args.push('-client', clientConfig);
    args.push('-logLevel', this.process.isDebugModeEnabled ? 'debug' : 'info');
    if (!isUdpEnabled) {
      args.push('-dnsFallback');
    }

    const whenProcessEnded = this.launchWithAutoRestart(args);

    // Either started successfully, or terminated exceptionally
    return Promise.race([this.whenStarted, whenProcessEnded]);
  }

  private monitorStarted(): Promise<void> {
    return (this.whenStarted = new Promise(resolve => {
      this.process.onStdOut = (data?: string | Buffer) => {
        if (data?.toString().includes('tun2socks running')) {
          console.debug('[tun2socks] - started');
          this.process.onStdOut = null;
          resolve();
        }
      };
    }));
  }

  private async launchWithAutoRestart(args: string[]): Promise<void> {
    console.debug('[tun2socks] - starting to route network traffic ...', args);
    let restarting = false;
    let lastError: Error | null = null;
    do {
      if (restarting) {
        console.warn('[tun2socks] - exited unexpectedly; restarting ...');
      }
      restarting = false;
      this.monitorStarted()
        .then(() => {
          restarting = true;
        })
        .catch(e => {
          console.error('[tun2socks] - failed to monitor start:', e);
        });
      try {
        lastError = null;
        await this.process.launch(args, false);
        console.info('[tun2socks] - exited with no errors');
      } catch (e) {
        console.error('[tun2socks] - terminated due to:', e);
        lastError = e;
      }
    } while (!this.stopRequested && restarting);
    if (lastError) {
      throw lastError;
    }
  }

  stop() {
    this.stopRequested = true;
    return this.process.stop();
  }

  enableDebugMode() {
    this.process.isDebugModeEnabled = true;
  }
}
