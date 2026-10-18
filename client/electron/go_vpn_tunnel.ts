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

  private disconnected = false;
  private suspended = false;
  private connecting?: Promise<void>;
  private restarting?: Promise<void>;
  private restartRequested = false;
  private readonly onSuspend = () => {
    void this.suspendListener().catch(e => {
      console.error('could not suspend tun2socks:', e);
    });
  };
  private readonly onResume = () => {
    void this.resumeListener().catch(e => {
      console.error('could not resume tun2socks:', e);
    });
  };

  private isUdpEnabled = false;
  private gatewayAdapterIndex?: string;

  private readonly onAllHelpersStopped: Promise<void>;
  private resolveAllHelpersStopped: () => void;

  private reconnectingListener?: () => void;

  private reconnectedListener?: () => void;

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
    if (this.disconnected) {
      throw new Error('tunnel is disconnected');
    }
    this.connecting = this.connectInternal(checkProxyConnectivity);
    try {
      await this.connecting;
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }

  private async connectInternal(checkProxyConnectivity: boolean) {
    if (IS_WINDOWS) {
      // Windows: when the system suspends, tun2socks terminates due to the TAP device getting
      // closed.
      powerMonitor.on('suspend', this.onSuspend);
      powerMonitor.on('resume', this.onResume);
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

    this.ensureConnected();
    console.log('starting routing daemon');
    this.gatewayAdapterIndex = await this.routing.start();
    this.ensureConnected();
    await this.startTun2socks();
    this.ensureConnected();
  }

  private ensureConnected() {
    if (this.disconnected) {
      throw new Error('tunnel is disconnected');
    }
  }

  networkChanged(status: TunnelStatus, gatewayIndex?: string) {
    if (this.disconnected) {
      return;
    }
    if (status === TunnelStatus.CONNECTED) {
      if (gatewayIndex) {
        this.gatewayAdapterIndex = gatewayIndex;
      }
      this.reconnectingListener?.();
      void this.updateUdpAndRestartTun2socks()
        .then(() => {
          if (!this.disconnected && !this.suspended) {
            this.reconnectedListener?.();
          }
        })
        .catch(e => {
          console.error('could not restart tun2socks after network change:', e);
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
    this.suspended = true;
    // Preemptively stop tun2socks to avoid a silent restart that will fail.
    await this.tun2socks.stop();
    console.log('stopped tun2socks in preparation for suspend');
  }

  private async resumeListener() {
    if (this.disconnected) {
      return;
    }
    this.suspended = false;

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

  private updateUdpAndRestartTun2socks(): Promise<void> {
    this.restartRequested = true;
    if (!this.restarting) {
      this.restarting = this.restartTun2socks();
    }
    return this.restarting;
  }

  private async restartTun2socks() {
    try {
      // A network notification can arrive while the initial connection is starting.
      await this.connecting;
      while (this.restartRequested && !this.disconnected && !this.suspended) {
        this.restartRequested = false;
        await this.checkUdpAndRestartTun2socks();
      }
    } finally {
      // Clear ownership before settling the worker promise. A request arriving
      // in a later microtask must not join a worker that has already finished.
      this.restarting = undefined;
    }
  }

  private async checkUdpAndRestartTun2socks() {
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

    if (this.disconnected || this.suspended) {
      return;
    }
    // Restart tun2socks.
    try {
      await this.tun2socks.stop();
    } catch {
      // Ignore the errors
    }
    if (!this.disconnected && !this.suspended) {
      await this.startTun2socks();
    }
  }

  // Use #onceDisconnected to be notified when the tunnel terminates.
  async disconnect() {
    if (this.disconnected) {
      return this.onAllHelpersStopped;
    }
    // Mark this before awaiting anything, so in-flight checks cannot restart it.
    this.disconnected = true;

    if (IS_WINDOWS) {
      powerMonitor.removeListener('suspend', this.onSuspend);
      powerMonitor.removeListener('resume', this.onResume);
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
  private running?: Promise<void>;
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

  private async startWithPlatformSpecificArgs(
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

    if (this.running) {
      return Promise.reject(new Error('tun2socks is already running'));
    }
    this.stopRequested = false;
    const whenProcessEnded = (this.running = this.launchWithAutoRestart(
      args
    ).finally(() => {
      this.running = undefined;
    }));

    let timeout: NodeJS.Timeout;
    try {
      await Promise.race([
        this.whenStarted,
        whenProcessEnded,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('tun2socks startup timed out'));
          }, 30000);
        }),
      ]);
    } catch (e) {
      try {
        await this.stop();
      } catch {
        // Preserve the startup error rather than the expected termination signal.
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  private monitorStarted(): Promise<void> {
    return (this.whenStarted = new Promise(resolve => {
      const readyMessage = 'tun2socks running';
      let output = '';
      this.process.onStdOut = (data?: string | Buffer) => {
        output += data?.toString() ?? '';
        if (output.includes(readyMessage)) {
          console.debug('[tun2socks] - started');
          this.process.onStdOut = null;
          resolve();
        } else {
          // Preserve only enough text to recognize a marker split across chunks.
          output = output.slice(-(readyMessage.length - 1));
        }
      };
    }));
  }

  private async launchWithAutoRestart(args: string[]): Promise<void> {
    console.debug('[tun2socks] - starting to route network traffic ...');
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
        if (!this.stopRequested && !restarting) {
          lastError = new Error('tun2socks exited before becoming ready');
        }
      } catch (e) {
        console.error('[tun2socks] - terminated due to:', e);
        lastError = e;
      }
    } while (!this.stopRequested && restarting);
    if (lastError) {
      throw lastError;
    }
  }

  async stop() {
    this.stopRequested = true;
    const running = this.running;
    try {
      await this.process.stop();
    } finally {
      // Finish the old restart loop before a new start can reset stopRequested.
      await running;
    }
  }

  enableDebugMode() {
    this.process.isDebugModeEnabled = true;
  }
}
