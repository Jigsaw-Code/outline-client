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

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as sudo from 'sudo-prompt';

import * as errors from '../www/model/errors';
import * as outline_util from './util'

const isWindows = os.platform() === 'win32';
const isLinux = os.platform() === 'linux';

// Windows Pipe Information ---- For Windows
const SERVICE_PIPE_NAME = 'OutlineServicePipe';
const SERVICE_PIPE_PATH = '\\\\.\\pipe\\';

// Locating the script is tricky: when packaged, this basically boils down to:
//   c:\program files\Outline\
// but during development:
//   build/windows
//
// Surrounding quotes important, consider "c:\program files"!

// Unix socket information ---- For Linux
const SERVICE_USOCK_NAME = 'outline_controller';
const SERVICE_USOCK_PATH = '/var/run/';


interface RoutingServiceRequest {
  action: string;
  parameters: {[parameter: string]: string|boolean};
}

interface RoutingServiceResponse {
  statusCode: RoutingServiceStatusCode;
  errorMessage?: string;
}

enum RoutingServiceAction {
  CONFIGURE_ROUTING = 'configureRouting',
  RESET_ROUTING = 'resetRouting',
  GET_DEVICE_NAME = 'getDeviceName'
}

enum RoutingServiceStatusCode {
  SUCCESS = 0,
  GENERIC_FAILURE = 1,
  UNSUPPORTED_ROUTING_TABLE = 2
}

// Define the error type thrown by the net module.
interface NetError extends Error {
  code?: string|number;
  errno?: string;
  syscall?: string;
  address?: string;
}

// Abstracts IPC with OutlineService in order to configure routing.
export class RoutingService {
  private ipcConnection: net.Socket;

  // Asks OutlineService to configure all traffic, except that bound for the proxy server,
  // to route via routerIp.
  configureRouting(routerIp: string, proxyIp: string, isAutoConnect = false): Promise<string> {
    return this.sendRequest({
      action: RoutingServiceAction.CONFIGURE_ROUTING,
      parameters: {proxyIp, routerIp, isAutoConnect}
    });
  }

  // Restores the default system routes.
  resetRouting(): Promise<string> {
    return this.sendRequest({action: RoutingServiceAction.RESET_ROUTING, parameters: {}});
  }

  // Returns the name of the device.
  getDeviceName(): Promise<string> {
    return this.sendRequest({action: RoutingServiceAction.GET_DEVICE_NAME, parameters: {}});
  }

  // Helper method to perform IPC with the Windows Service. Prompts the user for admin permissions
  // to start the service, in the event that it is not running.
  private sendRequest(request: RoutingServiceRequest, retry = true): Promise<string> {
    return new Promise((resolve, reject) => {

      this.ipcConnection = net.createConnection(
          isWindows ? `${SERVICE_PIPE_PATH}${SERVICE_PIPE_NAME}` :
                      `${SERVICE_USOCK_PATH}${SERVICE_USOCK_NAME}`,
          () => {
            console.log('Pipe connected');
            try {
              const msg = JSON.stringify(request);
              this.ipcConnection.write(msg);
            } catch (e) {
              reject(new Error(`Failed to serialize JSON request: ${e.message}`));
            }
          });

      this.ipcConnection.on('error', (e: NetError) => {
        if (retry) {
          console.info(`bouncing OutlineService (${e.errno})`);
          sudo.exec(
              outline_util.getServiceStartCommand(), {name: 'Outline'},
              (sudoError, stdout, stderr) => {
                if (sudoError) {
                  // Yes, this seems to be the only way to tell.
                  if ((typeof sudoError === 'string') &&
                      sudoError.toLowerCase().indexOf('did not grant permission') >= 0) {
                    return reject(new errors.NoAdminPermissions());
                  } else {
                    // It's unclear what type sudoError is because it has no message
                    // field. toString() seems to work in most cases, so use that -
                    // anything else will eventually show up in Sentry.
                    return reject(new errors.ConfigureSystemProxyFailure(sudoError.toString()));
                  }
                }
                console.info(
                    `ran install_windows_service.bat (stdout: ${stdout}, stderr: ${stderr})`);
                this.sendRequest(request, false).then(resolve, reject);
              });
          return;
        } else {
          reject(new Error(`Routing Daemon/Service is not running.`));
        }
        // OutlineService could not be (re-)started.
        reject(new errors.ConfigureSystemProxyFailure(
            `Received error from service connection: ${e.message}`));
      });

      this.ipcConnection.on('data', (data) => {
        console.log('Got data from pipe');
        if (data) {
          try {
            const response = JSON.parse(data.toString());
            if (response.statusCode !== RoutingServiceStatusCode.SUCCESS) {
              const msg = `OutlineService says: ${response.errorMessage}`;
              reject(
                  response.statusCode === RoutingServiceStatusCode.UNSUPPORTED_ROUTING_TABLE ?
                      new errors.UnsupportedRoutingTable(msg) :
                      new errors.ConfigureSystemProxyFailure(msg));
            }
            // In case the response has returnValue key we return the value otherwise
            // we return the returned json value.
            // This is used when we read tun device name from the daemon
            if ('returnValue' in response) {
              return resolve(response.returnValue);
            } else {
              return resolve(data.toString());
            }
          } catch (e) {
            reject(new Error(`Failed to deserialize service response: ${e.message}`));
          }
        } else {
          reject(new Error('Failed to receive data form routing service'));
        }
        try {
          this.ipcConnection.destroy();
        } catch (e) {
          // Don't reject, the service may have disconnected the pipe already.
        }
      });
    });
  }
}
