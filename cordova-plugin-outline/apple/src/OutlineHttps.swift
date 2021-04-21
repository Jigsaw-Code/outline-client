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

import Foundation

struct HttpsRequest {
  let url: String
  let method: String
  let certFingerprint: Data?
}

struct HttpsResponse {
  let statusCode: UInt
  let body: Data?
  let redirectUrl: String?
}

private let operationQueue: OperationQueue = {
  let queue = OperationQueue()
  queue.maxConcurrentOperationCount = 1
  queue.qualityOfService = .userInitiated
  return queue
}()

private let kTimeoutSeconds: TimeInterval = 30

/**
 * Retrieves data over HTTPs. When `request.certificateFingerprint` is set, validates the server TLS
 * certificate by comparing its fingerprint to the trusted certificate fingerprint.
 *
 * - Parameter request: HTTP request to send.
 * - Parameter completion: block called when the request is done.
 */
func HttpsFetch(request: HttpsRequest, completion: @escaping(HttpsResponse?, Error?) -> Void) {
  guard let url = URL(string: request.url), url.scheme == "https" else {
    return completion(nil, URLError(.badURL))
  }
  var urlRequest = URLRequest(url: url)
  urlRequest.httpMethod = request.method

  let config = URLSessionConfiguration.ephemeral
  config.timeoutIntervalForRequest = kTimeoutSeconds
  config.timeoutIntervalForResource = kTimeoutSeconds
  let session = URLSession(configuration: config,
                           delegate: HttpsSessionDelegate(certSha256Data: request.certFingerprint),
                           delegateQueue: operationQueue)
  let task = session.dataTask(with: urlRequest) { (data, urlResponse, error) in
    guard error == nil else {
      return completion(nil, error)
    }
    guard let httpResponse = urlResponse as? HTTPURLResponse else {
      return completion(nil, URLError(.cannotParseResponse))
    }
    let redirectUrl = httpResponse.allHeaderFields["Location"] as? String
    let response = HttpsResponse(
      statusCode: UInt(httpResponse.statusCode), body: data, redirectUrl: redirectUrl)
    completion(response, nil)
  }
  task.resume()
}

private class HttpsSessionDelegate: NSObject, URLSessionTaskDelegate {
  private let certSha256Data: Data?

  init(certSha256Data: Data?) {
    self.certSha256Data = certSha256Data
  }

  func urlSession(
      _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard self.certSha256Data != nil else {
      // No pinned certificate, let the system validate the challenge.
      return completionHandler(.performDefaultHandling, nil)
    }
    let protectionSpace = challenge.protectionSpace
    guard protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      return completionHandler(.performDefaultHandling, nil)
    }
    guard let serverTrust = protectionSpace.serverTrust else {
      return completionHandler(.performDefaultHandling, nil)
    }
    guard let serverCertificate = SecTrustGetCertificateAtIndex(serverTrust, 0) else {
      return completionHandler(.performDefaultHandling, nil)
    }
    // Validate the SHA256 hash of the DER-encoded server certificate.
    let serverCertificateData = SecCertificateCopyData(serverCertificate) as Data
    if self.certSha256Data == serverCertificateData.sha256 {
      completionHandler(.useCredential, URLCredential(trust: serverTrust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  func urlSession(_: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection: HTTPURLResponse,
                  newRequest: URLRequest, completionHandler: (URLRequest?) -> Void) {
    completionHandler(nil) // Do not follow redirects.
  }
}
