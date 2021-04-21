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

extension Data {
  /**
   * Creates data with the contents of a hex-encoded string.
   *
   * - Parameter hex: the hex-encoded string, optionally colon-delimited
   * - Returns: a Data instance or nil if decoding fails.
   */
  init?(hex: String) {
    let hex = hex.replacingOccurrences(of: ":", with: "")
    if hex.count < 2 || hex.count % 2 != 0 {
      return nil
    }
    let chars = hex.map {$0}
    let bytes = stride(from: 0, to: chars.count, by: 2)
        .map { String(chars[$0]) + String(chars[$0 + 1]) }
        .compactMap { UInt8($0, radix: 16) }
    self.init(bytes)
  }

  /**
   * Computes the SHA256 hash of the data.
   *
   * - Returns: a Data instance with the contents of the digest.
   */
  var sha256: Data {
    var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    self.withUnsafeBytes {
        _ = CC_SHA256($0.baseAddress, CC_LONG(self.count), &hash)
    }
    return Data(hash)
  }
}
