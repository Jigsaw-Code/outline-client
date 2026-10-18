// Copyright 2018 The Outline Authors
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

import {createConnection, Socket} from 'net';
import {platform} from 'os';
import * as path from 'path';

import * as sudo from 'sudo-prompt';

import {pathToEmbeddedOutlineService} from './app_paths';
import {TunnelStatus} from '../web/app/outline_server_repository/vpn';
import {ErrorCode} from '../web/model/errors';
import {PlatformError, GoErrorCode} from '../web/model/platform_error';

const isWindows = platform() === 'win32';
const SERVICE_NAME = '\\\\.\\pipe\\OutlineServicePipe';

interface RoutingServiceRequest {
  action: string;
  parameters: {[parameter: string]: string | boolean};
}

interface RoutingServiceResponse {
  action: RoutingServiceAction; // Matches RoutingServiceRequest.action
  statusCode: RoutingServiceStatusCode;
  errorMessage?: string;
  connectionStatus: TunnelStatus;
  gatewayAdapterIndex?: string;
}

enum RoutingServiceAction {
  CONFIGURE_ROUTING = 'configureRouting',
  RESET_ROUTING = 'resetRouting',
  STATUS_CHANGED = 'statusChanged',
}

enum RoutingServiceStatusCode {
  SUCCESS = 0,
  GENERIC_FAILURE = 1,
  UNSUPPORTED_ROUTING_TABLE = 2,
}

// Communicates with the Outline routing daemon via a Windows named pipe.
//
// A minimal life-cycle is supported:
//  - CONFIGURE_ROUTING is *always* the first message sent on the pipe.
//  - The only subsequent supported operation is RESET_ROUTING.
//  - In the meantime, the client may receive zero or more STATUS_CHANGED events.
//
// That's it! This helps us connect to the service for *as short a time as possible*, which is
// important since only one client may be connected to the Windows service at any given time.
//
// To test:
//  - Windows: net start|stop OutlineService
export class RoutingDaemon {
  private socket: Socket | null | undefined;

  private stopping = false;

  private fulfillDisconnect!: () => void;

  private disconnected = new Promise<void>(F => {
    this.fulfillDisconnect = F;
  });

  private networkChangeListener?: (
    status: TunnelStatus,
    gatewayIndex?: string
  ) => void;

  constructor(
    private proxyAddress: string,
    private isAutoConnect: boolean
  ) {}

  // Fulfills once a connection is established with the routing daemon *and* it has successfully
  // configured the system's routing table.
  // Returns a string representing the network adapter index that connects to the gateway.
  async start() {
    if (this.stopping) {
      throw new Error('routing daemon has been stopped');
    }
    return new Promise<string>((fulfill, reject) => {
      const socket = (this.socket = createConnection(SERVICE_NAME));
      const timeout = setTimeout(() => {
        reject(new Error('routing daemon configuration timed out'));
        socket.destroy();
      }, 30000);

      socket.once('close', () => {
        clearTimeout(timeout);
        this.socket = null;
        this.fulfillDisconnect();
        // Also settle start() if the service closes before its first response.
        reject(
          new Error('routing daemon closed before configuration completed')
        );
      });
      socket.once('error', err => {
        clearTimeout(timeout);
        const perr = new PlatformError(
          GoErrorCode.ROUTING_SERVICE_NOT_RUNNING,
          'routing daemon connection failed',
          {cause: err}
        );
        reject(new Error(perr.toJSON()));
        socket.destroy();
      });
      socket.once('connect', () => {
        if (this.stopping) {
          socket.destroy();
          return;
        }
        socket.once('data', data => {
          clearTimeout(timeout);
          const message = this.parseRoutingServiceResponse(data);
          if (
            !message ||
            message.action !== RoutingServiceAction.CONFIGURE_ROUTING ||
            message.statusCode !== RoutingServiceStatusCode.SUCCESS
          ) {
            reject(
              new Error(
                message?.errorMessage || 'invalid routing service response'
              )
            );
            socket.destroy();
            return;
          }
          socket.on('data', this.dataHandler.bind(this));
          if (this.stopping) {
            reject(
              new Error('routing daemon stopped before configuration completed')
            );
          } else {
            fulfill(message.gatewayAdapterIndex);
          }
        });
        socket.write(
          JSON.stringify({
            action: RoutingServiceAction.CONFIGURE_ROUTING,
            parameters: {
              proxyIp: this.proxyAddress,
              isAutoConnect: this.isAutoConnect,
            },
          } as RoutingServiceRequest)
        );
      });
    });
  }

  private dataHandler(data: Buffer) {
    const message = this.parseRoutingServiceResponse(data);
    if (!message) {
      return;
    }
    switch (message.action) {
      case RoutingServiceAction.STATUS_CHANGED:
        if (this.networkChangeListener) {
          this.networkChangeListener(
            message.connectionStatus,
            message.gatewayAdapterIndex
          );
        }
        break;
      case RoutingServiceAction.RESET_ROUTING:
        // TODO: examine statusCode
        if (this.socket) {
          this.socket.end();
        }
        break;
      default:
        console.error(
          `unexpected message from background service: ${data.toString()}`
        );
    }
  }

  // Parses JSON `data` as a `RoutingServiceResponse`. Logs the error and returns undefined on
  // failure.
  private parseRoutingServiceResponse(
    data: Buffer
  ): RoutingServiceResponse | undefined {
    if (!data) {
      console.error('received empty response from routing service');
      return undefined;
    }
    let response: RoutingServiceResponse | undefined = undefined;
    try {
      response = JSON.parse(data.toString());
    } catch {
      console.error(
        `failed to parse routing service response: ${data.toString()}`
      );
    }
    return response;
  }

  private async writeReset() {
    return new Promise<void>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('routing daemon is disconnected'));
        return;
      }
      this.socket.write(
        JSON.stringify({
          action: RoutingServiceAction.RESET_ROUTING,
          parameters: {},
        } as RoutingServiceRequest),
        err => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Wait for the service to release its single-client pipe before another tunnel starts.
  async stop() {
    if (this.stopping) {
      return this.disconnected;
    }
    this.stopping = true;
    const socket = this.socket;
    if (!socket) {
      this.fulfillDisconnect();
      return;
    }
    const timeout = setTimeout(() => {
      console.warn('routing daemon did not disconnect in time; closing pipe');
      socket.destroy();
    }, 10000);
    try {
      if (socket.connecting) {
        socket.destroy();
      } else {
        await this.writeReset();
      }
      await this.disconnected;
    } catch (e) {
      socket.destroy();
      await this.disconnected;
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  get onceDisconnected() {
    return this.disconnected;
  }

  set onNetworkChange(
    newListener: (
      status: TunnelStatus,
      gatewayIndex?: string
    ) => void | undefined
  ) {
    this.networkChangeListener = newListener;
  }
}

//#region routing service installation

/**
 * Execute arbitary shell `command` as root.
 * @param command command Any valid shell command(s).
 */
function executeCommandAsRoot(command: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sudo.exec(command, {name: 'Outline'}, (sudoError, stdout, stderr) => {
      console.info(stdout);
      console.error(stderr);

      if (sudoError) {
        // This error message is an un-exported constant defined here:
        //   - https://github.com/jorangreef/sudo-prompt/blob/v9.2.1/index.js#L670
        if (sudoError.message?.includes('did not grant permission')) {
          console.error('user rejected to run command as root');
          reject(ErrorCode.NO_ADMIN_PERMISSIONS);
        } else {
          console.error('command is running as root but failed: ', sudoError);
          reject(ErrorCode.UNEXPECTED);
        }
      } else {
        resolve();
      }
    });
  });
}

function installWindowsRoutingServices(): Promise<void> {
  const WINDOWS_INSTALLER_FILENAME = 'install_windows_service.bat';

  // Locating the script is tricky: when packaged, this basically boils down to:
  //   c:\program files\Outline\
  // but during development:
  //   build/windows
  //
  // Surrounding quotes important, consider "c:\program files"!
  const script = `"${path.join(
    pathToEmbeddedOutlineService(),
    WINDOWS_INSTALLER_FILENAME
  )}"`;
  return executeCommandAsRoot(script);
}

export async function installRoutingServices(): Promise<void> {
  console.info('installing outline routing service...');
  if (!isWindows) {
    throw new Error('unsupported os');
  }
  await installWindowsRoutingServices();
  console.info('outline routing service installed successfully');
}

//#endregion routing service installation
