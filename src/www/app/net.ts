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

// Exposes native networking capabilities to the web app.
export interface NativeNetworking {
  // Sends a request `req` to retrieve data from an HTTPs server.
  // When `req.certFingerprint` is set, validates the server TLS certificate
  // by comparing its fingerprint to the trusted certificate fingerprint.
  // Throws if `req.url` is not a valid HTTPs URL or if `req.method` is not a
  // valid HTTP method.
  // Throws on DNS resolution and network connectivity failures.
  fetchHttps(req: HttpsRequest): Promise<HttpsResponse>;

  // Returns whether a server is reachable via TCP at address `${hostname}:${port}`.
  isServerReachable(hostname: string, port: number): Promise<boolean>;
}

export interface HttpsRequest {
  // HTTPs endpoint to request.
  readonly url: string;
  // HTTP method to use in the request. Falsy values default to 'GET'.
  readonly method?: string;
  // Colon-delimited HEX encoded SHA-256 certificate hash to pin as a trusted TLS certificate.
  // E.g.
  // 46:0A:B9:69:C4:D4:93:34:34:BC:83:4D:13:8A:6C:6B:17:B7:36:C1:92:CF:F2:CD:57:69:80:6C:50:F8:3F:12
  readonly hexSha256CertFingerprint?: string;
}

export interface HttpsResponse {
  // HTTP status code.
  readonly statusCode: number;
  // Data read from the response body.
  readonly body?: string;
  // HTTP 'Location' header. Set when the response is a redirect.
  readonly redirectUrl?: string;
}
