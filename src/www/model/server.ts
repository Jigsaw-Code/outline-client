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

import {ShadowsocksConfig, ShadowsocksConfigSource} from './shadowsocks';

// TODO: add guidelines for this file

export interface Server {
  // A unique id that identifies this Server.
  readonly id: string;

  // The name of this server, as given by the user.
  name: string;

  // Domain name or IP address, and port of the server.
  readonly host: string;

  // The message identifier corresponding to the server error state. This identifier
  // must match one of the localized app message.
  errorMessageId?: string;

  // Connects to the server, redirecting the device's traffic.
  connect(): Promise<void>;

  // Disconnects from the server and stops any traffic redirection.
  disconnect(): Promise<void>;

  // Checks whether the server is already active and in use.
  checkRunning(): Promise<boolean>;

  // Checks whether the server is reachable.
  checkReachable(): Promise<boolean>;
}


export interface ServerConfig {
  // Static proxy configuration.
  readonly proxy?: ShadowsocksConfig;

  // Dynamic proxy configuration retrieval source.
  source?: ShadowsocksConfigSource;

  // User-given name.
  name?: string;
}

export interface ServerRepository {
  add(serverConfig: ServerConfig): void;
  update(serverId: string, newConfig: ServerConfig): void;
  forget(serverId: string): void;
  undoForget(serverId: string): void;
  getAll(): Server[];
  getById(serverId: string): Server|undefined;
}
