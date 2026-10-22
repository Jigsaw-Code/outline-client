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

import AppIntents
import Foundation
import NetworkExtension
import SwiftUI
import WidgetKit

private enum OutlineVpnControlBridge {
  private enum ConfigKey {
    static let tunnelId = "id"
    static let transport = "transport"
  }

  /// Maximum time to wait for the VPN to reach a stopped state before giving up,
  /// so the caller (e.g. a Control Center intent) can never block indefinitely.
  private static let kStopTunnelTimeoutNanoseconds: UInt64 = 10 * NSEC_PER_SEC

  static func currentState() async -> (isConnected: Bool, serverName: String?) {
    guard let manager = await getTunnelManager() else {
      return (false, nil)
    }
    #if compiler(>=6.0)
      if #available(iOS 18.0, *) {
        OutlineVpnControlStatusObserver.shared.start()
      }
    #endif
    return (isConnectedSession(manager.connection), serverName(for: manager))
  }

  static func startConfiguredTunnel() async throws {
    guard let manager = await getTunnelManager() else {
      throw OutlineVpnControlError.noConfiguredTunnel
    }

    if isActiveSession(manager.connection) {
      await stop(manager)
    }

    try await manager.loadFromPreferences()
    manager.isEnabled = true
    try await manager.saveToPreferences()
    try await manager.loadFromPreferences()

    guard let session = manager.connection as? NETunnelProviderSession else {
      throw OutlineVpnControlError.invalidTunnelSession
    }
    try session.startTunnel(options: [:])

    do {
      try await setConnectVpnOnDemand(manager, true)
    } catch {
      // The VPN is already starting; failing to save on-demand should not flip the control back.
    }
  }

  static func stopActiveTunnel() async {
    guard let manager = await getTunnelManager() else {
      return
    }
    await stop(manager)
  }

  private static func stop(_ manager: NETunnelProviderManager) async {
    do {
      try await setConnectVpnOnDemand(manager, false)
    } catch {
      // Stop the session even if preference updates fail.
    }
    await stopTunnel(manager.connection)
  }

  /// Stops the tunnel and waits until the connection reaches a stopped state.
  ///
  /// `.NEVPNStatusDidChange` is delivered on the main thread while this runs on a
  /// background cooperative thread, so the continuation is guarded by `ResumeOnce`
  /// to guarantee a single, race-free resume (resuming a continuation twice traps).
  /// A timeout ensures a stuck or immediately-reconnecting session can never block
  /// the caller forever.
  private static func stopTunnel(_ connection: NEVPNConnection) async {
    guard !isStoppedSession(connection) else {
      return
    }

    // Runs its body at most once, safe to call from multiple threads.
    final class ResumeOnce {
      private let lock = NSLock()
      private var hasRun = false

      func run(_ body: () -> Void) {
        lock.lock()
        let shouldRun = !hasRun
        hasRun = true
        lock.unlock()
        if shouldRun {
          body()
        }
      }
    }

    final class TokenHolder {
      var token: NSObjectProtocol?
    }

    let resumeOnce = ResumeOnce()
    let tokenHolder = TokenHolder()

    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      func finish() {
        resumeOnce.run {
          if let token = tokenHolder.token {
            NotificationCenter.default.removeObserver(
              token,
              name: .NEVPNStatusDidChange,
              object: connection
            )
          }
          continuation.resume()
        }
      }

      func finishIfStopped() {
        if isStoppedSession(connection) {
          finish()
        }
      }

      tokenHolder.token = NotificationCenter.default.addObserver(
        forName: .NEVPNStatusDidChange,
        object: connection,
        queue: nil
      ) { _ in
        finishIfStopped()
      }

      // Fail open: never block the caller forever if the session does not reach a
      // stopped state (for example, if on-demand immediately reconnects).
      Task {
        try? await Task.sleep(nanoseconds: kStopTunnelTimeoutNanoseconds)
        finish()
      }

      connection.stopVPNTunnel()
      finishIfStopped()
    }
  }

  private static func getTunnelManager() async -> NETunnelProviderManager? {
    do {
      let managers = try await NETunnelProviderManager.loadAllFromPreferences()
      return managers.first { isOutlineTunnel($0) } ?? managers.first
    } catch {
      return nil
    }
  }

  private static func isOutlineTunnel(_ manager: NETunnelProviderManager) -> Bool {
    let protoConfig = manager.protocolConfiguration as? NETunnelProviderProtocol
    return protoConfig?.providerConfiguration?[ConfigKey.tunnelId] as? String != nil &&
      protoConfig?.providerConfiguration?[ConfigKey.transport] as? String != nil
  }

  private static func serverName(for manager: NETunnelProviderManager) -> String? {
    guard let name = manager.localizedDescription, !name.isEmpty else {
      return nil
    }
    return name
  }

  private static func setConnectVpnOnDemand(
    _ manager: NETunnelProviderManager,
    _ enabled: Bool
  ) async throws {
    try await manager.loadFromPreferences()
    if enabled {
      let connectRule = NEOnDemandRuleConnect()
      connectRule.interfaceTypeMatch = .any
      manager.onDemandRules = [connectRule]
    }
    manager.isOnDemandEnabled = enabled
    try await manager.saveToPreferences()
  }

  private static func isActiveSession(_ session: NEVPNConnection?) -> Bool {
    let status = session?.status
    return status == .connected || status == .connecting ||
      status == .disconnecting || status == .reasserting
  }

  private static func isConnectedSession(_ session: NEVPNConnection?) -> Bool {
    let status = session?.status
    return status == .connected || status == .connecting ||
      status == .reasserting
  }

  private static func isStoppedSession(_ session: NEVPNConnection?) -> Bool {
    let status = session?.status
    return status == .disconnected || status == .invalid
  }
}

enum OutlineVpnControlError: Error {
  case noConfiguredTunnel
  case invalidTunnelSession
}

#if compiler(>=6.0)

@available(iOS 18.0, *)
private final class OutlineVpnControlStatusObserver {
  static let shared = OutlineVpnControlStatusObserver()

  private var token: NSObjectProtocol?

  private init() {}

  func start() {
    guard token == nil else {
      return
    }
    token = NotificationCenter.default.addObserver(
      forName: .NEVPNStatusDidChange,
      object: nil,
      queue: nil
    ) { _ in
      Task { @MainActor in
        ControlCenter.shared.reloadControls(ofKind: OutlineVpnToggleControl.kind)
      }
    }
  }
}

@available(iOS 18.0, *)
struct OutlineVpnControlValue {
  let isConnected: Bool
  let serverName: String?
}

@available(iOS 18.0, *)
struct OutlineVpnToggleControl: ControlWidget {
  static let kind = OutlineControlKind.vpnToggle

  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: Self.kind, provider: Provider()) { value in
      ControlWidgetToggle(
        isOn: value.isConnected,
        action: ToggleOutlineVpnIntent()
      ) {
        Label("Outline VPN", systemImage: "circle.lefthalf.filled")
      } valueLabel: { isOn in
        Text(labelText(isOn: isOn, serverName: value.serverName))
      }
    }
    .displayName("Outline VPN")
    .description("Connect or disconnect the last used Outline server.")
  }

  private func labelText(isOn: Bool, serverName: String?) -> String {
    if isOn {
      return serverName.map { "Connected to \($0)" } ?? "Connected"
    }
    return serverName.map { "Connect to \($0)" } ?? "Open Outline to connect"
  }
}

@available(iOS 18.0, *)
extension OutlineVpnToggleControl {
  struct Provider: ControlValueProvider {
    let previewValue = OutlineVpnControlValue(isConnected: false, serverName: "Outline")

    func currentValue() async throws -> OutlineVpnControlValue {
      let state = await OutlineVpnControlBridge.currentState()
      return OutlineVpnControlValue(
        isConnected: state.isConnected,
        serverName: state.serverName
      )
    }
  }
}

@available(iOS 18.0, *)
struct ToggleOutlineVpnIntent: SetValueIntent {
  static var title: LocalizedStringResource = "Toggle Outline VPN"

  @Parameter(title: "Connected")
  var value: Bool

  init() {}

  func perform() async throws -> some IntentResult {
    if value {
      try await OutlineVpnControlBridge.startConfiguredTunnel()
    } else {
      await OutlineVpnControlBridge.stopActiveTunnel()
    }
    return .result()
  }
}

@available(iOS 18.0, *)
@main
struct OutlineControlsBundle: WidgetBundle {
  var body: some Widget {
    OutlineVpnToggleControl()
  }
}

#else

private struct OutlineControlsUnavailableEntry: TimelineEntry {
  let date: Date
}

private struct OutlineControlsUnavailableProvider: TimelineProvider {
  func placeholder(in context: Context) -> OutlineControlsUnavailableEntry {
    OutlineControlsUnavailableEntry(date: Date())
  }

  func getSnapshot(
    in context: Context,
    completion: @escaping (OutlineControlsUnavailableEntry) -> Void
  ) {
    completion(OutlineControlsUnavailableEntry(date: Date()))
  }

  func getTimeline(
    in context: Context,
    completion: @escaping (Timeline<OutlineControlsUnavailableEntry>) -> Void
  ) {
    let entry = OutlineControlsUnavailableEntry(date: Date())
    completion(Timeline(entries: [entry], policy: .never))
  }
}

private struct OutlineControlsUnavailableWidget: Widget {
  private let kind = OutlineControlKind.vpnToggle

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: OutlineControlsUnavailableProvider()) { _ in
      EmptyView()
    }
    .configurationDisplayName("Outline VPN")
    .description("Requires Xcode 16 to build the iOS 18 Control Center control.")
  }
}

@main
struct OutlineControlsBundle: WidgetBundle {
  var body: some Widget {
    OutlineControlsUnavailableWidget()
  }
}

#endif
