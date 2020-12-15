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

export class ShadowsocksUnsupportedCipher extends OutlineError {
  constructor(public readonly cipher: string) {
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
//
// Must be kept in sync with its Cordova doppelganger:
//   cordova-plugin-outline/outlinePlugin.js
//
// TODO: Rename this class, "plugin" is a poor name since the Electron apps do not have plugins.
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
export class NoAdminPermissions extends RegularNativeError {}
export class SystemConfigurationException extends RegularNativeError {}
export class UnsupportedServerConfiguration extends RegularNativeError {}
export class TlsCertificateError extends RegularNativeError {}
export class DomainResolutionError extends RegularNativeError {}
export class HttpError extends RegularNativeError {
  constructor(public statusCode = 500) {
    super();
  }
}

//////
// Now, "unexpected" errors.
// Use these sparingly because each occurrence triggers a Sentry report.
//////

// Windows.
export class ShadowsocksStartFailure extends RedFlagNativeError {}
export class ConfigureSystemProxyFailure extends RedFlagNativeError {}
export class UnsupportedRoutingTable extends RedFlagNativeError {}

// Used on Android and Apple to indicate that the plugin failed to establish the VPN tunnel.
export class VpnStartFailure extends RedFlagNativeError {}

// This must be kept in sync with:
//  - cordova-plugin-outline/apple/src/OutlineVpn.swift#ErrorCode
//  - cordova-plugin-outline/apple/vpn/PacketTunnelProvider.h#NS_ENUM
//  - cordova-plugin-outline/outlinePlugin.js#ERROR_CODE
//  - cordova-plugin-outline/android/java/org/outline/OutlinePlugin.java#ErrorCode
//
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
  CONFIGURE_SYSTEM_PROXY_FAILURE = 9,
  NO_ADMIN_PERMISSIONS = 10,
  UNSUPPORTED_ROUTING_TABLE = 11,
  SYSTEM_MISCONFIGURED = 12,
  DNS_RESOLUTION_ERROR = 13,
  TLS_CERTIFICATE_ERROR = 14,
  HTTP_ERROR = 15,
  UNSUPPORTED_SERVER_CONFIGURATION = 16
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
    case ErrorCode.NO_ADMIN_PERMISSIONS:
      return new NoAdminPermissions();
    case ErrorCode.UNSUPPORTED_ROUTING_TABLE:
      return new UnsupportedRoutingTable();
    case ErrorCode.SYSTEM_MISCONFIGURED:
      return new SystemConfigurationException();
    case ErrorCode.DNS_RESOLUTION_ERROR:
      return new DomainResolutionError();
    case ErrorCode.TLS_CERTIFICATE_ERROR:
      return new TlsCertificateError();
    case ErrorCode.HTTP_ERROR:
      return new HttpError();
    default:
      throw new Error(`unknown ErrorCode ${errorCode}`);
  }
}

// Converts a NativeError to an ErrorCode.
// Throws if the error is not a subclass of NativeError.
export function toErrorCode(e: NativeError): ErrorCode {
  if (e instanceof UnexpectedPluginError) {
    return ErrorCode.UNEXPECTED;
  } else if (e instanceof VpnPermissionNotGranted) {
    return ErrorCode.VPN_PERMISSION_NOT_GRANTED;
  } else if (e instanceof InvalidServerCredentials) {
    return ErrorCode.INVALID_SERVER_CREDENTIALS;
  } else if (e instanceof RemoteUdpForwardingDisabled) {
    return ErrorCode.UDP_RELAY_NOT_ENABLED;
  } else if (e instanceof ServerUnreachable) {
    return ErrorCode.SERVER_UNREACHABLE;
  } else if (e instanceof VpnStartFailure) {
    return ErrorCode.VPN_START_FAILURE;
  } else if (e instanceof IllegalServerConfiguration) {
    return ErrorCode.ILLEGAL_SERVER_CONFIGURATION;
  } else if (e instanceof ShadowsocksStartFailure) {
    return ErrorCode.SHADOWSOCKS_START_FAILURE;
  } else if (e instanceof ConfigureSystemProxyFailure) {
    return ErrorCode.CONFIGURE_SYSTEM_PROXY_FAILURE;
  } else if (e instanceof UnsupportedRoutingTable) {
    return ErrorCode.UNSUPPORTED_ROUTING_TABLE;
  } else if (e instanceof NoAdminPermissions) {
    return ErrorCode.NO_ADMIN_PERMISSIONS;
  } else if (e instanceof SystemConfigurationException) {
    return ErrorCode.SYSTEM_MISCONFIGURED;
  } else if (e instanceof DomainResolutionError) {
    return ErrorCode.DNS_RESOLUTION_ERROR;
  } else if (e instanceof TlsCertificateError) {
    return ErrorCode.TLS_CERTIFICATE_ERROR;
  } else if (e instanceof HttpError) {
    return ErrorCode.HTTP_ERROR;
  }
  throw new Error(`unknown NativeError ${e.name}`);
}
