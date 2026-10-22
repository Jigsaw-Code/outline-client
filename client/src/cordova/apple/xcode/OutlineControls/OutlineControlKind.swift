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

/// Identifiers for the Outline Control Center controls.
///
/// This file is compiled into both the OutlineControls widget extension and the
/// main app (cordova-plugin-outline). Sharing the source guarantees the control
/// registration in the extension and the app's
/// `ControlCenter.reloadControls(ofKind:)` calls always use the same kind
/// string, so a single edit here keeps them in sync.
enum OutlineControlKind {
  /// Kind identifier for the Outline VPN Control Center toggle.
  static let vpnToggle = "org.outline.ios.client.OutlineVpnToggleControl"
}
