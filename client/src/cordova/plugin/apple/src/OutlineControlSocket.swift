// Copyright 2026 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Foundation
import Darwin

/// Same-user, local-only command transport. The app owns all VPN operations.
/// No TCP listener, URL command handler, access keys, or root helper.
final class OutlineControlSocket {
  enum Failure: Error { case unsafeDirectory, pathTooLong, socket, alreadyRunning }
  typealias Handler = ([String: Any], @escaping ([String: Any]) -> Void) -> Void
  private let listener: Int32
  private let path: String

  init(directory: String = NSHomeDirectory() + "/.outline-cli", handler: @escaping Handler) throws {
    let fm = FileManager.default
    try fm.createDirectory(atPath: directory, withIntermediateDirectories: true,
                           attributes: [.posixPermissions: 0o700])
    var info = stat()
    guard lstat(directory, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFDIR,
          info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else {
      throw Failure.unsafeDirectory
    }
    path = directory + "/control.sock"
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw Failure.pathTooLong }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
      for (i, byte) in bytes.enumerated() { buffer[i] = UInt8(bitPattern: byte) }
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Failure.socket }
    var ready = false
    defer { if !ready { Darwin.close(fd) } }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    if lstat(path, &info) == 0 {
      guard (info.st_mode & S_IFMT) == S_IFSOCK, info.st_uid == geteuid() else { throw Failure.unsafeDirectory }
      let probe = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
      guard probe >= 0 else { throw Failure.socket }
      let active = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
      }
      let probeError = errno
      Darwin.close(probe)
      guard active != 0, probeError == ECONNREFUSED else { throw Failure.alreadyRunning }
      guard unlink(path) == 0 else { throw Failure.socket }
    }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0 else { throw Failure.socket }
    guard chmod(path, 0o600) == 0, Darwin.listen(fd, 4) == 0 else {
      unlink(path)
      throw Failure.socket
    }
    listener = fd
    ready = true
    // Bounded parallel readers keep status available during VPN transitions.
    DispatchQueue(label: "outline.local-control").async { [self] in
      let capacity = DispatchSemaphore(value: 4)
      while true {
        capacity.wait()
        let peer = Darwin.accept(listener, nil, nil)
        if peer < 0 {
          capacity.signal()
          if errno == EINTR { continue }; break
        }
        DispatchQueue.global(qos: .utility).async {
          self.serve(peer, handler: handler)
          Darwin.close(peer)
          capacity.signal()
        }
      }
    }
  }

  private func serve(_ fd: Int32, handler: @escaping Handler) {
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == geteuid() else { return }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var data = Data()
    var byte: UInt8 = 0
    let deadline = Date().addingTimeInterval(5)
    while data.count < 32768 && Date() < deadline {
      guard Darwin.read(fd, &byte, 1) == 1 else { return }
      if byte == 10 { break }
      data.append(byte)
    }
    guard byte == 10, data.count < 32768,
          var request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          request["v"] as? Int == 1 else {
      reply(fd, ["ok": false, "error": "invalid_request"])
      return
    }
    request["id"] = UUID().uuidString
    request["deadline"] = Date().addingTimeInterval(115).timeIntervalSince1970 * 1000
    let semaphore = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var response: [String: Any] = ["ok": false, "error": "timeout_outcome_unknown"]
    var completed = false
    DispatchQueue.main.async {
      handler(request) { result in
        lock.lock()
        if !completed { response = result; completed = true; semaphore.signal() }
        lock.unlock()
      }
    }
    _ = semaphore.wait(timeout: .now() + 120)
    lock.lock()
    completed = true
    let finalResponse = response
    lock.unlock()
    reply(fd, finalResponse)
  }

  private func reply(_ fd: Int32, _ response: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: response), data.count < 65535 else { return }
    data.append(10)
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      var sent = 0
      while sent < raw.count {
        let n = Darwin.write(fd, base.advanced(by: sent), raw.count - sent)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
        sent += n
      }
    }
  }
}
