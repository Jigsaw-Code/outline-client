// Copyright 2020 The Outline Authors
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

// Typings for cordova-plugin-outline

declare type HttpsRequest = import('../../www/app/net').HttpsRequest;
declare type HttpsResponse = import('../../www/app/net').HttpsResponse;
declare type Tunnel = import('../../www/app/tunnel').Tunnel;
declare type TunnelStatus = import('../../www/app/tunnel').TunnelStatus;
declare type ShadowsocksConfig = import('../../www/app/config').ShadowsocksConfig;

declare namespace cordova.plugins.outline {
  const log: {
    // Initializes the error reporting framework with the supplied credentials.
    initialize(apiKey: string): Promise<void>;

    // Sends previously captured logs and events to the error reporting
    // framework.
    // Associates the report to the provided unique identifier.
    send(uuid: string): Promise<void>;
  };

  const net: {
    fetchHttps(req: HttpsRequest): Promise<HttpsResponse>;
    isServerReachable(hostname: string, port: number): Promise<boolean>;
  };

  // Quits the application. Only supported in macOS.
  function quitApplication(): void;

  // Implements the Tunnel interface with native functionality.
  class Tunnel implements Tunnel {
    constructor(id: string);

    readonly id: string;

    start(config: ShadowsocksConfig): Promise<void>;

    stop(): Promise<void>;

    isRunning(): Promise<boolean>;

    onStatusChange(listener: (status: TunnelStatus) => void): void;
  }
}
