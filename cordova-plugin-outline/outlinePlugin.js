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

// TODO(alalama): Figure out how to write this file in Typescript, so that the app code can depend
// on classes and interfaces defined here.

const exec = require('cordova/exec');

const PLUGIN_NAME = 'OutlinePlugin';

const log = {
  initialize: function(apiKey) {
    return new Promise(function(resolve, reject) {
      exec(resolve, reject, PLUGIN_NAME, 'initializeErrorReporting', [apiKey]);
    });
  },

  send: function(uuid) {
    return new Promise(function(resolve, reject) {
      exec(resolve, reject, PLUGIN_NAME, 'reportEvents', [uuid]);
    });
  }
};

const net = {
  isServerReachable: function(hostname, port) {
    return new Promise(function(resolve, reject) {
      const rejectWithError = function(errorCode) {
        reject(new OutlinePluginError(errorCode));
      };
      exec(resolve, rejectWithError, PLUGIN_NAME, 'isServerReachable', [hostname, port]);
    });
  },

  fetchHttps: function(req) {
    return new Promise(function(resolve, reject) {
      const rejectWithError = function(errorMessage) {
        reject(new Error(errorMessage));
      };
      exec(resolve, rejectWithError, PLUGIN_NAME, 'fetchHttps', [req]);
    });
  }
};

function quitApplication() {
  exec(function() {}, function() {}, PLUGIN_NAME, 'quitApplication', []);
}

// This must be kept in sync with:
//  - cordova-plugin-outline/android/java/org/outline/OutlinePlugin.java#ErrorCode
//  - cordova-plugin-outline/apple/src/OutlineVpn.swift#ErrorCode
//  - cordova-plugin-outline/apple/vpn/PacketTunnelProvider.h#NS_ENUM
//  - www/model/errors.ts
const ERROR_CODE = {
  NO_ERROR: 0,
  UNEXPECTED: 1,
  VPN_PERMISSION_NOT_GRANTED: 2,
  INVALID_SERVER_CREDENTIALS: 3,
  UDP_RELAY_NOT_ENABLED: 4,
  SERVER_UNREACHABLE: 5,
  VPN_START_FAILURE: 6,
  ILLEGAL_SERVER_CONFIGURATION: 7,
  SHADOWSOCKS_START_FAILURE: 8,
  CONFIGURE_SYSTEM_PROXY_FAILURE: 9,
  NO_ADMIN_PERMISSIONS: 10,
  UNSUPPORTED_ROUTING_TABLE: 11,
  SYSTEM_MISCONFIGURED: 12
};

// This must be kept in sync with the TypeScript definition:
//   www/model/errors.ts
function OutlinePluginError(errorCode) {
  this.errorCode = errorCode || ERROR_CODE.UNEXPECTED;
}

// This must be kept in sync with the TypeScript definition:
//   www/app/tunnel.ts
const TunnelStatus = {
  CONNECTED: 0,
  DISCONNECTED: 1,
  RECONNECTING: 2
}

function Tunnel(id) {
  this.id = id;
}

Tunnel.prototype._promiseExec = function(cmd, args) {
  return new Promise(function(resolve, reject) {
    const rejectWithError = function(errorCode) {
      reject(new OutlinePluginError(errorCode));
    };
    exec(resolve, rejectWithError, PLUGIN_NAME, cmd, [this.id].concat(args));
  }.bind(this));
};

Tunnel.prototype._exec = function(cmd, args, success, error) {
  exec(success, error, PLUGIN_NAME, cmd, [this.id].concat(args));
};

Tunnel.prototype.start = function(config) {
  if (!config) {
    throw new OutlinePluginError(ERROR_CODE.ILLEGAL_SERVER_CONFIGURATION);
  }
  return this._promiseExec('start', [config]);
};

Tunnel.prototype.stop = function() {
  return this._promiseExec('stop', []);
};

Tunnel.prototype.isRunning = function() {
  return this._promiseExec('isRunning', []);
};

Tunnel.prototype.onStatusChange = function(listener) {
  const onError = function(err) {
    console.warn('failed to execute status change listener', err);
  };
  this._exec('onStatusChange', [], listener, onError);
};

module.exports = {
  Tunnel: Tunnel,
  TunnelStatus: TunnelStatus,
  log: log,
  net: net,
  quitApplication: quitApplication,
};
