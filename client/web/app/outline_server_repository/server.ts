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

import {Localizer} from '@outline/infrastructure/i18n';
import * as net from '@outline/infrastructure/net';

import {
  parseTunnelConfig,
  FirstHopAndTunnelConfigJson,
  DynamicServiceConfig,
  StaticServiceConfig,
  parseAccessKey,
  ServiceConfig,
  ConnectionType,
} from './config';
import {StartRequestJson, VpnApi} from './vpn';
import * as errors from '../../model/errors';
import {PlatformError} from '../../model/platform_error';
import {Server} from '../../model/server';
import {getDefaultMethodChannel} from '../method_channel';

// PLEASE DON'T use this class outside of this `outline_server_repository` folder!

export async function newOutlineServer(
  vpnApi: VpnApi,
  id: string,
  name: string | undefined,
  accessKey: string,
  localize: Localizer
): Promise<Server> {
  const serviceConfig = await parseAccessKey(accessKey);
  name = name ?? serviceConfig.name;

  if (serviceConfig instanceof DynamicServiceConfig) {
    const tunnelConfigLocation = serviceConfig.transportConfigLocation;
    if (!name) {
      name =
        tunnelConfigLocation.port === '443' || !tunnelConfigLocation.port
          ? tunnelConfigLocation.hostname
          : net.joinHostPort(
              tunnelConfigLocation.hostname,
              tunnelConfigLocation.port
            );
    }
    const server = new OutlineServer(vpnApi, id, name, serviceConfig);
    return server;
  } else if (serviceConfig instanceof StaticServiceConfig) {
    if (!name) {
      name = localize(
        accessKey.includes('outline=1')
          ? 'server-default-name-outline'
          : 'server-default-name'
      );
    }
    return new OutlineServer(vpnApi, id, name, serviceConfig);
  }
}

class OutlineServer implements Server {
  errorMessageId?: string;
  private startRequest: StartRequestJson;

  constructor(
    private vpnApi: VpnApi,
    readonly id: string,
    public name: string,
    private serviceConfig: ServiceConfig
  ) {
    if (serviceConfig instanceof StaticServiceConfig) {
      this.startRequest = {
        id,
        name,
        firstHop: serviceConfig.firstHop,
        client: serviceConfig.client,
      };
    }
  }

  get address() {
    return this.startRequest?.firstHop || '';
  }

  async connect() {
    let connectionType: ConnectionType;
    if (this.serviceConfig instanceof DynamicServiceConfig) {
      const tunnelConfig = await fetchTunnelConfig(
        this.serviceConfig.transportConfigLocation
      );
      this.startRequest = {
        id: this.id,
        name: this.name,
        firstHop: tunnelConfig.firstHop,
        client: tunnelConfig.client,
      };
      connectionType = tunnelConfig.connectionType;
    } else {
      connectionType = this.serviceConfig.connectionType;
    }

    // Make sure the transport is not proxyless for now.
    // TODO remove this when proxyless is supported on the frontend
    if (this.startRequest && connectionType === ConnectionType.DIRECT) {
      throw new errors.InvalidServiceConfiguration(
        'Proxyless connections are not supported'
      );
    }

    try {
      await this.vpnApi.start(this.startRequest);
    } catch (cause) {
      // TODO(junyi): Remove the catch above once all platforms are migrated to PlatformError
      if (cause instanceof PlatformError) {
        throw cause;
      }

      // e originates in "native" code: either the Capacitor plugin or Electron's main process.
      // Because of this, we cannot assume "instanceof OutlinePluginError" will work.
      if (cause.errorCode) {
        throw errors.fromErrorCode(cause.errorCode);
      }

      throw new errors.ProxyConnectionFailure(
        `Failed to connect to server ${this.name}.`,
        {cause}
      );
    }
  }

  async disconnect() {
    try {
      await this.vpnApi.stop(this.id);

      if (this.serviceConfig instanceof DynamicServiceConfig) {
        this.startRequest = undefined;
      }
    } catch {
      // All the plugins treat disconnection errors as ErrorCode.UNEXPECTED.
      throw new errors.RegularNativeError();
    }
  }

  checkRunning(): Promise<boolean> {
    return this.vpnApi.isRunning(this.id);
  }
}

/** fetchTunnelConfig fetches information from a dynamic access key and attempts to parse it. */
// TODO(daniellacosse): unit tests
async function fetchTunnelConfig(
  configLocation: URL
): Promise<FirstHopAndTunnelConfigJson> {
  const responseBody = (
    await getDefaultMethodChannel().invokeMethod(
      'FetchResource',
      configLocation.toString()
    )
  ).trim();
  if (!responseBody) {
    throw new errors.InvalidServiceConfiguration(
      'Got empty config from dynamic key.'
    );
  }
  try {
    return parseTunnelConfig(responseBody);
  } catch (cause) {
    if (cause instanceof errors.SessionProviderError) {
      throw cause;
    }

    throw new errors.InvalidServiceConfiguration(
      'Failed to parse VPN information fetched from dynamic access key.',
      {cause}
    );
  }
}
