// Copyright 2021 The Outline Authors
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

import { IncomingMessage } from 'electron';
import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';

import {HttpsRequest, HttpsResponse} from '../www/app/net';
import * as errors from '../www/model/errors';

const HTTPS_TIMEOUT_MS = 30 * 1000;

/**
 * Retrieves data over HTTPs. When `request.certificateFingerprint` is set, validates the server TLS
 * certificate by comparing its fingerprint to the trusted certificate fingerprint.
 *
 * @param {HttpsRequest} request - HTTP request to send.
 * @returns {Promise<HtttpResponse>} - server HTTP response.
 * @throws {InvalidHttpsUrlError} - if `req.url` is not a valid HTTPs URL.
 * @throws {DomainResolutionError} - if the request host cannot be resolved.
 * @throws {CertificateValidationError} - if server certificate cannot be validated.
 * @throws {ConnectionTimeout} - if the connection times out.
 * @throws {ConnectionError} - if there are errors during the connection.
 * @throws {UnexpectedPluginError} - for other error condidtions.
 */
export async function fetchHttps(request: HttpsRequest): Promise<HttpsResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (e) {
    throw new errors.InvalidHttpsUrlError('failed to parse request URL');
  }
  if (url.protocol !== 'https:') {
    throw new errors.InvalidHttpsUrlError('protocol must be https');
  }
  const validateServerCertificate = !!request.hexSha256CertFingerprint;
  const agentOptions = {
    // Disable system validation when we need to validate the server certificate.
    rejectUnauthorized: !validateServerCertificate,
    // Don't cache TLS sessions so we can validate the server certificate on each request.
    maxCachedSessions: 0,
    timeout: HTTPS_TIMEOUT_MS,
  };
  const agent = new https.Agent(agentOptions);
  const options = {
    method: request.method || 'GET',
    agent,
    checkServerIdentity: (host: string, cert: tls.PeerCertificate) => {
      if (!validateServerCertificate) {
        const err = tls.checkServerIdentity(host, cert);
        if (err) {
          return err;
        }
      }

      const hexSha256CertFingerprint = cert.fingerprint256.replace(/:/g, '');
      if (hexSha256CertFingerprint !== request.hexSha256CertFingerprint) {
        return new errors.CertificateValidationError(
          `server certificate fingerprint ${request.hexSha256CertFingerprint} does not match trusted fingerprint ${hexSha256CertFingerprint}`);
      }
    }
  };

  const res: http.IncomingMessage = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = https.request(url, options, resolve);
    req.on('error', (err) => {
      reject(getOutlineError(err));
    });
    req.on('timeout', () => {
      req.emit('error', new errors.ConnectionTimeout());
      req.destroy();
    });
    req.end();
  });

    const statusCode = res.statusCode;
    if (statusCode >= 400) {
      return {statusCode};
    } else if (statusCode >= 300) {
      return {statusCode, redirectUrl: res.headers.location};
    }

    const data = await readResponseData(res);
    return {statusCode, data};
}

function readResponseData(res: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(data));
  });
}

function getOutlineError(e: Error): errors.OutlineError {
  if (e instanceof errors.OutlineError) {
    return e;
  }
  if (isNodeError(e)) {
    if (e.code === 'ENOTFOUND') {
      return new errors.DomainResolutionError('failed to resolve hostname');
    } else if (e.code === 'ECONNREFUSED') {
      return new errors.ConnectionError('connection refused');
    } else if (e.code === 'ECONNRESET') {
      return new errors.ConnectionError('connection reset');
    } else if (e.code === 'ETIMEDOUT') {
      return new errors.ConnectionTimeout();
    }
    return new errors.ConnectionError(`connection failed with code ${e.code}`);
  }
  return new errors.UnexpectedPluginError();
}

function isNodeError(err: Error): err is NodeJS.ErrnoException {
  return !!(err as NodeJS.ErrnoException).code;
}
