// Copyright 2024 The Outline Authors
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

import {CustomError} from '@outline/infrastructure/custom_error';

import * as errors from './errors';

/**
 * @fileoverview This file defines types and constants corresponding to the backend Go's
 * `platerrors` package. It will be used to receive native errors from Go, eventually being
 * transformed into a strongly-typed `errors.NativeError`.
 *
 * TODO(fortuna): Move this out of the model. It's an implementation detail, not a product concept.
 * We also need to move away from using loosely typed PlatformError in application code.
 */

/**
 * Creates a new {@link Error} instance with the name set to {@link GoErrorCode.INTERNAL_ERROR}.
 * @param cause An optional cause of this error.
 * @returns A non-null instance of {@link Error}.
 */
function createInternalError(cause?: unknown): Error {
  const options = {} as {cause?: Error};

  if (cause instanceof Error) {
    options.cause = cause;
  } else if (cause) {
    // Use String(cause) instead of cause.toString() or new String(cause) to cover
    // primitive types and Symbols.
    options.cause = new Error(String(cause));
  }

  const err = new Error('Internal service error', options);
  err.name = GoErrorCode.INTERNAL_ERROR;
  return err;
}

/**
 * Recursively validates and parses a {@link rawObj} into an {@link Error}.
 * @param {object} rawObj Any object that is returned by JSON.parse.
 * @returns {Error} A non-null instance of Error.
 * @throws {Error} Will be thrown when {@link rawObj} is invalid.
 */
function convertRawErrorObjectToError(rawObj: object): Error {
  if (!('code' in rawObj) || typeof rawObj.code !== 'string') {
    throw new Error('code is invalid');
  }
  const code = rawObj.code.trim() as GoErrorCode;
  if (!code) {
    throw new Error('code is empty');
  }
  if (!('message' in rawObj) || typeof rawObj.message !== 'string') {
    throw new Error('message is invalid');
  }

  let detailsMessage = rawObj.message;
  let detailsMap = {};
  if ('details' in rawObj) {
    if (typeof rawObj.details !== 'object') {
      throw new Error('details is invalid');
    }
    if (rawObj.details) {
      detailsMap = rawObj.details;
      detailsMessage = makeDetailsString(
        rawObj.message,
        <ErrorDetails>rawObj.details
      );
    }
  }
  let cause: Error;
  if ('cause' in rawObj) {
    if (typeof rawObj.cause !== 'object') {
      throw new Error('cause is invalid');
    }
    if (rawObj.cause) {
      cause = convertRawErrorObjectToError(rawObj.cause);
    }
  }

  switch (code) {
    case GoErrorCode.FETCH_CONFIG_FAILED:
      return new errors.SessionConfigFetchFailed(detailsMessage, {cause});
    case GoErrorCode.INVALID_CONFIG:
      return new errors.InvalidServiceConfiguration(detailsMessage, {cause});
    case GoErrorCode.PROXY_SERVER_UNREACHABLE:
      return new errors.ServerUnreachable(detailsMessage, {cause});
    case GoErrorCode.ROUTING_SERVICE_NOT_RUNNING:
      return new errors.SystemConfigurationException(detailsMessage, {cause});
    case GoErrorCode.VPN_PERMISSION_NOT_GRANTED:
      return new errors.VpnPermissionNotGranted(detailsMessage, {cause});
    case GoErrorCode.PROVIDER_ERROR:
      return new errors.SessionProviderError(
        rawObj.message,
        (detailsMap as {details?: string})?.details
      );
    default: {
      const error = new Error(detailsMessage, {cause});
      error.name = String(code);
      return error;
    }
  }
}

function makeDetailsString(
  detailsMessage?: string,
  detailsMap?: object
): string {
  let result = detailsMessage;
  if (detailsMap) {
    result += '\nDetails: ';
    try {
      result += JSON.stringify(detailsMap, null, 2);
    } catch {
      result += '<Unable To Show>';
    }
  }
  return result;
}

/**
 * Recursively converts a {@link PlatformError} into a raw JavaScript object that
 * could be converted into a JSON string.
 * @param {PlatformError} platErr Any non-null PlatformError.
 * @returns {object} A plain JavaScript object that can be converted to JSON.
 */
function convertPlatformErrorToRawErrorObject(platErr: PlatformError): object {
  const rawObj: {
    code: string;
    message: string;
    details?: ErrorDetails;
    cause?: object;
  } = {
    code: String(platErr.code),
    message: platErr.message,
    details: platErr.details,
  };
  if (platErr.cause) {
    let cause: PlatformError;
    if (platErr.cause instanceof PlatformError) {
      cause = platErr.cause;
    } else {
      cause = new PlatformError(
        GoErrorCode.INTERNAL_ERROR,
        String(platErr.cause)
      );
    }
    rawObj.cause = convertPlatformErrorToRawErrorObject(cause);
  }
  return rawObj;
}

/**
 * ErrorDetails represents the details map of a {@link PlatformError}.
 * The keys in this map are strings, and the values can be of any data type.
 */
export type ErrorDetails = {[key: string]: unknown};

/**
 * PlatformError is used to communicate error details from Go to TypeScript.
 */
export class PlatformError extends CustomError {
  readonly details?: ErrorDetails = null;

  /**
   * Constructs a new PlatformError instance with the specified parameters.
   * @param {GoErrorCode} code An ErrorCode representing the category of this error.
   * @param {string} message A user-readable string of this error.
   * @param options An object containing the optional details and cause.
   */
  constructor(
    readonly code: GoErrorCode,
    message: string,
    options?: {
      details?: ErrorDetails;
      cause?: Error;
    }
  ) {
    super(message, options);
    this.details = options?.details;
  }

  /**
   * Returns a user readable string of this error with all details and causes.
   * @returns {string} A user friendly string representing this error.
   */
  toString(): string {
    let result = this.code + '\n' + this.message;
    if (this.details) {
      result += '\nDetails: ';
      try {
        result += JSON.stringify(this.details, null, 2);
      } catch {
        result += '<Unable To Show>';
      }
    }
    if (this.cause) {
      // Indent and append
      result += '\nCaused by:\n' + String(this.cause).replace(/^/gm, '  ');
    }
    return result;
  }

  /**
   * Returns a JSON string of this error with all details and causes.
   * @returns {string} The JSON string representing this error.
   */
  toJSON(): string {
    const errRawObj = convertPlatformErrorToRawErrorObject(this);
    return JSON.stringify(errRawObj);
  }
}

/**
 * De-serializes a cross-component-boundary error object into an {@link Error}.
 *
 * The error object can be one of the following types:
 * - A raw JSON string representation of a PlatformError.
 * - An Error whose message is a raw JSON string representation of a PlatformError.
 * - Otherwise, an {@link INTERNAL_ERROR} {@link PlatformError} with {@link errObj} as its cause
 *   will be returned.
 *
 * @param errObj The error object to be parsed.
 * @returns A non-null Error object.
 *
 * @example
 * try {
 *   // native plugin calls or electron IPC calls
 * } catch (e) {
 *   throw deserializeError(e);
 * }
 */
export function deserializeError(errObj: string | Error | unknown): Error {
  if (typeof errObj === 'undefined' || errObj === null) {
    return createInternalError();
  }
  if (errObj instanceof PlatformError) {
    return errObj;
  }

  let rawJSON: string;
  let rawObj: object;
  if (typeof errObj === 'string') {
    rawJSON = errObj;
  } else if (errObj instanceof Error) {
    rawJSON = errObj.message;
  } else if (typeof errObj === 'object') {
    rawObj = errObj;
  } else {
    return createInternalError(errObj);
  }

  if (rawJSON) {
    try {
      rawObj = JSON.parse(rawJSON);
    } catch {
      return createInternalError(errObj);
    }
  }

  if (typeof rawObj !== 'object' || !rawObj) {
    return createInternalError(errObj);
  }
  try {
    return convertRawErrorObjectToError(rawObj);
  } catch {
    return createInternalError(errObj);
  }
}

//////
// Error Code Definitions
// They should be identical to the ones defined in Go's `platerrors` package.
//////

/**
 * ErrorCode can be used to identify the specific type of a {@link PlatformError}.
 * You can reliably use the constant values to check for specific errors.
 */
export enum GoErrorCode {
  INTERNAL_ERROR = 'ERR_INTERNAL_ERROR',
  FETCH_CONFIG_FAILED = 'ERR_FETCH_CONFIG_FAILURE',
  INVALID_CONFIG = 'ERR_INVALID_CONFIG',
  PROVIDER_ERROR = 'ERR_PROVIDER',
  VPN_PERMISSION_NOT_GRANTED = 'ERR_VPN_PERMISSION_NOT_GRANTED',
  PROXY_SERVER_UNREACHABLE = 'ERR_PROXY_SERVER_UNREACHABLE',
  /** Indicates that the OS routing service is not running (electron only). */
  ROUTING_SERVICE_NOT_RUNNING = 'ERR_ROUTING_SERVICE_NOT_RUNNING',
}
