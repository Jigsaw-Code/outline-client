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

/// <reference path='../../types/ambient/outlinePlugin.d.ts'/>

import * as errors from '../model/errors';
import * as events from '../model/events';
import {Server, ServerConfig} from '../model/server';
import {ShadowsocksConfig, ShadowsocksConfigSource} from '../model/shadowsocks';

import {PersistentServer} from './persistent_server';
import {Tunnel, TunnelStatus} from './tunnel';

export class OutlineServer implements PersistentServer {
  // We restrict to AEAD ciphers because unsafe ciphers are not supported in outline-go-tun2socks.
  // https://shadowsocks.org/en/spec/AEAD-Ciphers.html
  private static readonly SUPPORTED_CIPHERS =
      ['chacha20-ietf-poly1305', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'];

  constructor(
      public readonly id: string, public readonly config: ServerConfig, private tunnel: Tunnel,
      private eventQueue: events.EventQueue) {
    this.tunnel.onStatusChange((status: TunnelStatus) => {
      let statusEvent: events.OutlineEvent;
      switch (status) {
        case TunnelStatus.CONNECTED:
          statusEvent = new events.ServerConnected(this);
          break;
        case TunnelStatus.DISCONNECTED:
          statusEvent = new events.ServerDisconnected(this);
          break;
        case TunnelStatus.RECONNECTING:
          statusEvent = new events.ServerReconnecting(this);
          break;
        default:
          console.warn(`Received unknown tunnel status ${status}`);
          return;
      }
      eventQueue.enqueue(statusEvent);
    });
  }

  get name() {
    return this.config.name || this.tunnel.config ?.name || this.host || '';
  }

  set name(newName: string) {
    this.config.name = newName;
    if (this.tunnel.config) {
      this.tunnel.config.name = newName;
    }
  }

  get host() {
    if (this.tunnel.config) {
      return `${this.tunnel.config.host}:${this.tunnel.config.port}`;
    }
    // TODO(alalama): refine which components of the source URL to show.
    return this.config.source ?.url || '';
  }

  async connect() {
    try {
      if (this.config.source) {
        console.log(`fetching proxy config`);
        const response = await this.tunnel.fetchProxyConfig(this.config.source);
        if (response.statusCode >= 400) {
          console.error(`failed to fetch proxy config with status code ${response.statusCode}`);
          throw new errors.HttpError(response.statusCode);
        } else if (!response.proxies || response.proxies.length === 0) {
          console.error(`received empty proxy config list`);
          throw new errors.UnsupportedServerConfiguration();
        }
        if (response.redirectUrl && isPermanentRedirect(response.statusCode)) {
          this.eventQueue.enqueue(
              new events.ServerConfigSourceUrlChanged(this, response.redirectUrl));
        }

        // TODO(alalama): policy
        this.tunnel.config = response.proxies[0];
      }
      await this.tunnel.start();
    } catch (e) {
      if (this.config.source) {
        // Remove the proxy configuration in case fetching succeeded but connecting failed.
        delete this.tunnel.config;
      }
      // e originates in "native" code: either Cordova or Electron's main process.
      // Because of this, we cannot assume "instanceof OutlinePluginError" will work.
      if (e.errorCode) {
        throw errors.fromErrorCode(e.errorCode);
      }
      throw e;
    }
  }

  async disconnect() {
    try {
      await this.tunnel.stop();
    } catch (e) {
      // All the plugins treat disconnection errors as ErrorCode.UNEXPECTED.
      throw new errors.RegularNativeError();
    } finally {
      if (this.config.source) {
        delete this.tunnel.config;
      }
    }
  }

  checkRunning(): Promise<boolean> {
    return this.tunnel.isRunning();
  }

  checkReachable(): Promise<boolean> {
    return this.tunnel.isReachable();
  }

  public static isServerCipherSupported(cipher?: string) {
    return cipher !== undefined && OutlineServer.SUPPORTED_CIPHERS.includes(cipher);
  }
}

function isPermanentRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 308;
}
