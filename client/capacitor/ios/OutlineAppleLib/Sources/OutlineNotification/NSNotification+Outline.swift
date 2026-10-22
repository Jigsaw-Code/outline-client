// Copyright 2023 The Outline Authors
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

// TODO: Move this to a better location and clean up where notifications get
// sent and consumed.

public extension Notification.Name {
    static let kAppQuit = Notification.Name("appQuit")
    static let kHandleUrl = Notification.Name("handleUrl")
    static let kVpnConnected = Notification.Name("vpnConnected")
    static let kVpnDisconnected = Notification.Name("vpnDisconnected")
}

@objc public extension NSNotification {
    static let kAppQuit = Notification.Name.kAppQuit
    static let kHandleUrl = Notification.Name.kHandleUrl
    static let kVpnConnected = Notification.Name.kVpnConnected
    static let kVpnDisconnected = Notification.Name.kVpnDisconnected
}
