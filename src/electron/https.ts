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

import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';

import {HttpsRequest, HttpsResponse} from '../www/app/net';

const HTTPS_TIMEOUT_MS = 30 * 1000;

/**
 * Retrieves data over HTTPs. When `request.certificateFingerprint` is set, validates the server TLS
 * certificate by comparing its fingerprint to the trusted certificate fingerprint.
 *
 * @param {HttpsRequest} request - HTTP request to send.
 * @returns {Promise<HtttpResponse>} - server HTTP response.
 */
export async function fetchHttps(request: HttpsRequest): Promise<HttpsResponse> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:') {
    throw new Error('protocol must be https');
  }
  const validateServerCertificate = !!request.hexSha256CertFingerprint;
  const agentOptions = {
    // Disable system validation when we need to validate the server certificate.
    rejectUnauthorized: !validateServerCertificate,
    // Don't cache TLS sessions so we can validate the server certificate on each request.
    maxCachedSessions: 0,
  };
  const agent = new https.Agent(agentOptions);
  const options = {agent, method: request.method || 'GET', timeout: HTTPS_TIMEOUT_MS};
  const res: http.IncomingMessage = await new Promise(async (resolve, reject) => {
    const req = https.request(url, options, resolve);
    req.on('error', (e) => {
      // Send the system error code ('ECONNREFUSED', 'ETIMEDOUT') or the error message we emitted.
      reject(new Error(isNodeError(e) ? e.code : e.message));
    });
    req.on('timeout', () => {
      req.emit('error', new Error('connection timeout'));
      req.destroy();
    });
    const tlsSocket = await getTlsSocket(req);
    if (!validateServerCertificate) {
      if (!tlsSocket.authorized) {
        req.emit('error', new Error('failed to validate server certificate'));
        return req.destroy();
      }
      return req.end();
    }
    // Validate server certificate against the trusted certificate fingerprint.
    const cert = tlsSocket.getPeerCertificate();
    // cert.fingerprint256 is an upper-case colon-delimited HEX-encoded SHA256 string.
    if (request.hexSha256CertFingerprint !== cert.fingerprint256) {
      req.emit(
          'error', new Error('server certificate fingerprint does not match trusted fingerprint'));
      return req.destroy();
    }
    req.end();
  });

  const statusCode = res.statusCode;
  if (statusCode >= 400) {
    return {statusCode};
  } else if (statusCode >= 300) {
    return {statusCode, redirectUrl: res.headers.location};
  }

  const body = await readResponseData(res);
  return {statusCode, body};
}

function getTlsSocket(req: http.ClientRequest): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>(resolve => {
    req.on('socket', socket => {
      socket.on('secureConnect', () => {
        resolve(socket as tls.TLSSocket);
      });
    });
  });
}

function readResponseData(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const data: string[] = [];
    res.on('data', chunk => data.push(chunk));
    res.on('error', err => reject(err));
    res.on('end', () => resolve(data.join()));
  });
}

function isNodeError(e: Error): e is NodeJS.ErrnoException {
  return !!(e as NodeJS.ErrnoException).code;
}
