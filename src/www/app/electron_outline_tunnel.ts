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

import {ipcRenderer} from 'electron';
import * as promiseIpc from 'electron-promise-ipc';

import * as errors from '../model/errors';
import {ShadowsocksConfig, ShadowsocksConfigSource} from '../model/shadowsocks';

import {ProxyConfigResponse, Tunnel, TunnelStatus} from './tunnel';

export class ElectronOutlineTunnel implements Tunnel {
  private statusChangeListener: ((status: TunnelStatus) => void)|null = null;

  private running = false;

  constructor(public id: string, public config?: ShadowsocksConfig) {
    // This event is received when the proxy connects. It is mainly used for signaling the UI that
    // the proxy has been automatically connected at startup (if the user was connected at shutdown)
    ipcRenderer.on(`proxy-connected-${this.id}`, (e: Event) => {
      this.handleStatusChange(TunnelStatus.CONNECTED);
    });

    ipcRenderer.on(`proxy-reconnecting-${this.id}`, (e: Event) => {
      this.handleStatusChange(TunnelStatus.RECONNECTING);
    });
  }

  async fetchProxyConfig(source: ShadowsocksConfigSource): Promise<ProxyConfigResponse> {
    try {
      return promiseIpc.send('fetch-proxy-config', {source});
    } catch (e) {
      if (typeof e === 'number') {
        throw new errors.OutlinePluginError(e);
      }
      throw e;
    }
  }

  async start() {
    if (this.running) {
      return Promise.resolve();
    }

    ipcRenderer.once(`proxy-disconnected-${this.id}`, (e: Event) => {
      this.handleStatusChange(TunnelStatus.DISCONNECTED);
    });

    try {
      await promiseIpc.send('start-proxying', {config: this.config, id: this.id});
      this.running = true;
    } catch (e) {
      if (typeof e === 'number') {
        throw new errors.OutlinePluginError(e);
      } else {
        throw e;
      }
    }
  }

  async stop() {
    if (!this.running) {
      return;
    }

    try {
      await promiseIpc.send('stop-proxying');
      this.running = false;
    } catch (e) {
      console.error(`Failed to stop tunnel ${e}`);
    }
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  isReachable(): Promise<boolean> {
    return promiseIpc.send('is-reachable', this.config);
  }

  onStatusChange(listener: (status: TunnelStatus) => void): void {
    this.statusChangeListener = listener;
  }

  private handleStatusChange(status: TunnelStatus) {
    this.running = status === TunnelStatus.CONNECTED;
    if (this.statusChangeListener) {
      this.statusChangeListener(status);
    } else {
      console.error(`${this.id} status changed to ${status} but no listener set`);
    }
  }
}
