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

import {Server} from './server';

export class OutlineError extends Error {
  constructor(message?: string) {
    // ref:
    // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html#support-for-newtarget
    super(message);  // 'Error' breaks prototype chain here
    Object.setPrototypeOf(this,
                          new.target.prototype);  // restore prototype chain
    this.name = new.target.name;
  }
}

export class ServerAlreadyAdded extends OutlineError {
  constructor(public readonly server: Server) {
    super();
  }
}

export class ServerIncompatible extends OutlineError {
  constructor(message: string) {
    super(message);
  }
}

export class ServerUrlInvalid extends OutlineError {
  constructor(message: string) {
    super(message);
  }
}

export class OperationTimedOut extends OutlineError {
  constructor(public readonly timeoutMs: number, public readonly operationName: string) {
    super();
  }
}

export class FeedbackSubmissionError extends OutlineError {
  constructor() {
    super();
  }
}

// Error thrown by "native" code.
// Must be kept in sync with its Cordova doppelganger:
//   cordova-plugin-outline/outlinePlugin.js
export class OutlinePluginError extends OutlineError {
  constructor(public readonly errorCode: ErrorCode) {
    super();
  }
}

// Marker class for errors originating in native code.
// Bifurcates into two subclasses:
//  - "expected" errors originating in native code, e.g. incorrect password
//  - "unexpected" errors originating in native code, e.g. unhandled routing table
export class NativeError extends OutlineError {}
export class RegularNativeError extends NativeError {}
export class RedFlagNativeError extends NativeError {}

//////
// "Expected" errors.
//////
export class UnexpectedPluginError extends RegularNativeError {}
export class VpnPermissionNotGranted extends RegularNativeError {}
export class InvalidServerCredentials extends RegularNativeError {}
export class RemoteUdpForwardingDisabled extends RegularNativeError {}
export class ServerUnreachable extends RegularNativeError {}
export class IllegalServerConfiguration extends RegularNativeError {}
// TODO: Seems like a candidate for RedFlagNativeError; only used by Android?
export class VpnStartFailure extends RegularNativeError {}

//////
// Now, "unexpected" errors.
// Use these sparingly beacause each occurrence triggers a Sentry report.
//////
export class ShadowsocksStartFailure extends RedFlagNativeError {}
export class ConfigureSystemProxyFailure extends RedFlagNativeError {}

// This must be kept in sync with:
//  - cordova-plugin-outline/apple/src/OutlineVpn.swift#ErrorCode
//  - cordova-plugin-outline/apple/vpn/PacketTunnelProvider.h#NS_ENUM
//  - cordova-plugin-outline/outlinePlugin.js#ERROR_CODE
//
// TODO: Is it safe to re-use values here, i.e. is native node rebuilt in step with the TypeScript?
export const enum ErrorCode {
  // TODO: NO_ERROR is weird. Only used internally by the Android plugin?
  NO_ERROR = 0,
  // TODO: Rename to something more specific, or remove - only used by Android?
  UNEXPECTED = 1,
  VPN_PERMISSION_NOT_GRANTED = 2,
  INVALID_SERVER_CREDENTIALS = 3,
  UDP_RELAY_NOT_ENABLED = 4,
  SERVER_UNREACHABLE = 5,
  VPN_START_FAILURE = 6,
  ILLEGAL_SERVER_CONFIGURATION = 7,
  SHADOWSOCKS_START_FAILURE = 8,
  CONFIGURE_SYSTEM_PROXY_FAILURE = 9
}

// Converts an ErrorCode - originating in "native" code - to an instance of the relevant
// OutlineError subclass.
// Throws if the error code is not one defined in ErrorCode or is ErrorCode.NO_ERROR.
export function fromErrorCode(errorCode: ErrorCode): NativeError {
  switch (errorCode) {
    case ErrorCode.UNEXPECTED:
      return new UnexpectedPluginError();
    case ErrorCode.VPN_PERMISSION_NOT_GRANTED:
      return new VpnPermissionNotGranted();
    case ErrorCode.INVALID_SERVER_CREDENTIALS:
      return new InvalidServerCredentials();
    case ErrorCode.UDP_RELAY_NOT_ENABLED:
      return new RemoteUdpForwardingDisabled();
    case ErrorCode.SERVER_UNREACHABLE:
      return new ServerUnreachable();
    case ErrorCode.VPN_START_FAILURE:
      return new VpnStartFailure();
    case ErrorCode.ILLEGAL_SERVER_CONFIGURATION:
      return new IllegalServerConfiguration();
    case ErrorCode.SHADOWSOCKS_START_FAILURE:
      return new ShadowsocksStartFailure();
    case ErrorCode.CONFIGURE_SYSTEM_PROXY_FAILURE:
      return new ConfigureSystemProxyFailure();
    default:
      throw new Error(`unknown ErrorCode ${errorCode}`);
  }
}
