// Copyright 2018 The Outline Authors
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

import CocoaLumberjackSwift
import NetworkExtension
import OutlineError

// Manages the system's VPN tunnel through the VpnExtension process.
@objcMembers
public class OutlineVpn: NSObject {
  public static let shared = OutlineVpn()
  public static let domainExclusionsKey = "OutlineDomainExclusions"
  private static let desiredConnectedKey = "OutlineControlDesiredConnected"
  private static let kVpnExtensionBundleId = "\(Bundle.main.bundleIdentifier!).VpnExtension"

  public typealias VpnStatusObserver = (NEVPNStatus, String) -> Void

  private var vpnStatusObserver: VpnStatusObserver?

  private enum Action {
    static let start = "start"
    static let restart = "restart"
    static let stop = "stop"
    static let getTunnelId = "getTunnelId"
  }

  private enum ConfigKey {
    static let tunnelId = "id"
    static let transport = "transport"
  }

  override private init() {
    super.init()
    // Register observer for VPN changes.
    // Remove self to guard against receiving duplicate notifications due to page reloads.
    NotificationCenter.default.removeObserver(self, name: .NEVPNStatusDidChange, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(self.vpnStatusChanged),
                                           name: .NEVPNStatusDidChange, object: nil)
  }

  // MARK: - Interface

  /** Starts a VPN tunnel as specified in the OutlineTunnel object. */
  public func start(_ tunnelId: String, named name: String?, withTransport transportConfig: String) async throws {
    UserDefaults.standard.set(true, forKey: Self.desiredConnectedKey)
    if let manager = await getTunnelManager(), isActiveSession(manager.connection) {
      DDLogDebug("Stoppping active session before starting new one")
      guard await stopSession(manager) else {
        throw OutlineError.internalError(message: "Timed out stopping previous tunnel")
      }
    }

    let manager: NETunnelProviderManager
    do {
      manager = try await setupVpn(withId: tunnelId, named: name ?? "Outline Server", withTransport: transportConfig)
    } catch {
      DDLogError("Failed to setup VPN: \(error.localizedDescription)")
      throw OutlineError.vpnPermissionNotGranted(cause: error)
    }
    let session = manager.connection as! NETunnelProviderSession

    // Start the session.
    do {
      DDLogDebug("Calling NETunnelProviderSession.startTunnel([:])")
      try session.startTunnel(options: [:])
      DDLogDebug("NETunnelProviderSession.startTunnel() returned")
    } catch {
      DDLogError("Failed to start VPN: \(error.localizedDescription)")
      throw OutlineError.setupSystemVPNFailed(cause: error)
    }

    // Polling has a deadline and cannot miss an early status notification.
    do {
      try await waitForSession(session, terminal: [.connected, .disconnected, .invalid], timeout: 60, ignoreInitial: .disconnected)
    } catch {
      session.stopVPNTunnel()
      await setConnectVpnOnDemand(manager, false)
      throw error
    }

    switch manager.connection.status {
    case .connected:
      break
    case .disconnected, .invalid:
      guard let err = await fetchExtensionLastDisconnectError(session) else {
        throw OutlineError.internalError(message: "unexpected nil disconnect error")
      }
      throw err
    default:
      // This shouldn't happen.
      throw OutlineError.internalError(message: "unexpected connection status")
    }

    // Set an on-demand rule to connect to any available network to implement auto-connect on boot
    do { try await manager.loadFromPreferences() }
    catch {
      DDLogWarn("OutlineVpn.start: Failed to reload preferences: \(error.localizedDescription)")
    }
    let connectRule = NEOnDemandRuleConnect()
    connectRule.interfaceTypeMatch = .any
    manager.onDemandRules = [connectRule]
    manager.isOnDemandEnabled = true
    do { try await manager.saveToPreferences() }
    catch {
      DDLogWarn("OutlineVpn.start: Failed to save on-demand preference change: \(error.localizedDescription)")
    }
  }

  /** Tears down the VPN if the tunnel with id |tunnelId| is active. */
  public func stop(_ tunnelId: String) async {
    guard let manager = await getTunnelManager(),
          getTunnelId(forManager: manager) == tunnelId else {
      DDLogWarn("Trying to stop tunnel \(tunnelId) that is not running")
      return
    }
    UserDefaults.standard.set(false, forKey: Self.desiredConnectedKey)
    if isActiveSession(manager.connection) {
      await stopSession(manager)
    } else {
      await setConnectVpnOnDemand(manager, false)
    }
  }

  /// Non-secret state consumed by the local CLI and watchdog.
  public func controlSnapshot() async -> [String: Any] {
    guard let manager = await getTunnelManager() else {
      return ["serverId": NSNull(), "state": "disconnected", "onDemand": false, "desiredConnected": false]
    }
    let state: String
    switch manager.connection.status {
    case .connected: state = "connected"
    case .connecting: state = "connecting"
    case .reasserting: state = "reconnecting"
    case .disconnecting: state = "disconnecting"
    case .disconnected, .invalid: state = "disconnected"
    @unknown default: state = "unknown"
    }
    let desired = (UserDefaults.standard.object(forKey: Self.desiredConnectedKey) as? Bool) ?? manager.isOnDemandEnabled
    return ["serverId": getTunnelId(forManager: manager) as Any? ?? NSNull(),
            "state": state, "onDemand": manager.isOnDemandEnabled, "desiredConnected": desired]
  }

  /// Also disables auto-connect when the tunnel is already disconnected.
  public func controlDisconnect() async {
    UserDefaults.standard.set(false, forKey: Self.desiredConnectedKey)
    guard let manager = await getTunnelManager() else { return }
    if isActiveSession(manager.connection) {
      await stopSession(manager)
    } else {
      await setConnectVpnOnDemand(manager, false)
    }
  }

  /** Calls |observer| when the VPN's status changes. */
  public func onVpnStatusChange(_ observer: @escaping(VpnStatusObserver)) {
    vpnStatusObserver = observer
  }

  
  /** Returns whether |tunnelId| is actively proxying through the VPN. */
  public func isActive(_ tunnelId: String?) async -> Bool {
    guard tunnelId != nil, let manager = await getTunnelManager() else {
      return false
    }
    return getTunnelId(forManager: manager) == tunnelId && isActiveSession(manager.connection)
  }

  // MARK: - Helpers

  public func stopActiveVpn() async {
    UserDefaults.standard.set(false, forKey: Self.desiredConnectedKey)
    if let manager = await getTunnelManager() {
      await stopSession(manager)
    }
  }

  // Adds a VPN configuration to the user preferences if no Outline profile is present. Otherwise
  // enables the existing configuration.
  private func setupVpn(withId id:String, named name:String, withTransport transportConfig: String) async throws -> NETunnelProviderManager {
    let managers = try await NETunnelProviderManager.loadAllFromPreferences()
    var manager: NETunnelProviderManager!
    if managers.count > 0 {
      manager = managers.first
    } else {
      manager = NETunnelProviderManager()
    }

    manager.localizedDescription = name
    // Make sure on-demand is disable, so it doesn't retry on start failure.
    manager.onDemandRules = nil

    // Configure the protocol.
    let config = NETunnelProviderProtocol()
    // TODO(fortuna): set to something meaningful if we can.
    config.serverAddress = "Outline"
    config.providerBundleIdentifier = OutlineVpn.kVpnExtensionBundleId
    config.providerConfiguration = [
      ConfigKey.tunnelId: id,
      ConfigKey.transport: transportConfig,
      "domainExclusions": UserDefaults.standard.string(forKey: Self.domainExclusionsKey) ?? ""
    ]
    manager.protocolConfiguration = config

    // A VPN configuration must be enabled before it can be used to bring up a VPN tunnel.
    manager.isEnabled = true

    try await manager.saveToPreferences()
    // Workaround for https://forums.developer.apple.com/thread/25928
    try await manager.loadFromPreferences()
    return manager
  }

  // Receives NEVPNStatusDidChange notifications. Calls onTunnelStatusChange for the active
  // tunnel.
  func vpnStatusChanged(notification: NSNotification) {
    DDLogDebug("OutlineVpn.vpnStatusChanged: \(String(describing: notification))")
    guard let session = notification.object as? NETunnelProviderSession else {
      DDLogDebug("Bad session in OutlineVpn.vpnStatusChanged")
      return
    }
    guard let manager = session.manager as? NETunnelProviderManager else {
      // For some reason we get spurious notifications with connecting and disconnecting states
      DDLogDebug("Bad manager in OutlineVpn.vpnStatusChanged session=\(String(describing:session)) status=\(String(describing: session.status))")
      return
    }
    guard let protoConfig = manager.protocolConfiguration as? NETunnelProviderProtocol,
          let tunnelId = protoConfig.providerConfiguration?["id"] as? String else {
      DDLogWarn("Bad VPN Config: \(String(describing: session.manager.protocolConfiguration))")
      return
    }
    DDLogDebug("OutlineVpn received status change for \(tunnelId): \(String(describing: session.status))")
    self.vpnStatusObserver?(session.status, tunnelId)
  }
}

// Retrieves the application's tunnel provider manager from the VPN preferences.
private func getTunnelManager() async -> NETunnelProviderManager? {
  do {
    let managers: [NETunnelProviderManager] = try await NETunnelProviderManager.loadAllFromPreferences()
    guard managers.count > 0 else {
      DDLogDebug("OutlineVpn.getTunnelManager: No managers found")
      return nil
    }
    return managers.first
  } catch {
    DDLogError("Failed to get tunnel manager: \(error.localizedDescription)")
    return nil
  }
}

private func getTunnelId(forManager manager:NETunnelProviderManager?) -> String? {
  let protoConfig = manager?.protocolConfiguration as? NETunnelProviderProtocol
  return protoConfig?.providerConfiguration?["id"] as? String
}

private func isActiveSession(_ session: NEVPNConnection?) -> Bool {
  let vpnStatus = session?.status
  return vpnStatus == .connected || vpnStatus == .connecting || vpnStatus == .reasserting
}

// Bounded waits are essential when the caller is an unattended watchdog.
private func waitForSession(_ connection: NEVPNConnection, terminal: [NEVPNStatus], timeout: TimeInterval, ignoreInitial: NEVPNStatus? = nil) async throws {
  let deadline = ProcessInfo.processInfo.systemUptime + timeout
  var initial = ignoreInitial
  repeat {
    try await Task.sleep(nanoseconds: 100_000_000)
    // startTunnel can return before the system has left its old disconnected
    // state. A delayed transition is not evidence of connection failure.
    if connection.status == initial { continue }
    initial = nil
    if terminal.contains(connection.status) { return }
  } while ProcessInfo.processInfo.systemUptime < deadline
  throw OutlineError.internalError(message: "VPN transition timed out")
}

@discardableResult
private func stopSession(_ manager: NETunnelProviderManager) async -> Bool {
  do {
    try await manager.loadFromPreferences()
    manager.isOnDemandEnabled = false
    try await manager.saveToPreferences()
    manager.connection.stopVPNTunnel()
    try await waitForSession(manager.connection, terminal: [.disconnected, .invalid], timeout: 30)
    return true
  } catch {
    DDLogWarn("Failed to stop VPN")
    return false
  }
}

private func setConnectVpnOnDemand(_ manager: NETunnelProviderManager?, _ enabled: Bool) async {
  do {
    try await manager?.loadFromPreferences()
    manager?.isOnDemandEnabled = enabled
    try await manager?.saveToPreferences()
  } catch {
    DDLogError("Failed to set VPN on demand to \(enabled): \(error)")
    return
  }
}


// MARK: - Fetch last disconnect error

// Fetches the most recent error that caused the VPN extension to disconnect.
// Returns nil if the tunnel disconnected cleanly, or an Error describing the failure.
private func fetchExtensionLastDisconnectError(_ session: NETunnelProviderSession) async -> Error? {
  if #available(macOS 13.0, iOS 16.0, *) {
    return await withCheckedContinuation { continuation in
      DDLogDebug("Calling fetchLastDisconnectError")
      session.fetchLastDisconnectError { error in
        DDLogDebug("fetchLastDisconnectError returned: \(String(describing: error))")
        continuation.resume(returning: error)
      }
    }
  }
  // Fallback for macOS 12 / iOS 15: use IPC to read the error the extension saved to disk.
  // Note: sendProviderMessage returns nil when the session is disconnected, so this is best-effort.
  return await fetchExtensionLastDisconnectErrorViaIPC(session)
}

// TODO: Remove once we only support macOS 13.0+, iOS 16.0+
private enum ExtensionIPC {
  static let fetchLastDetailedJsonError = "fetchLastDisconnectDetailedJsonError"
}

/// Keep in sync with the data type defined in PacketTunnelProvider.Swift.
private struct LastErrorIPCData: Decodable {
  let errorCode: String
  let errorJson: String
}

// TODO: Remove once we only support macOS 13.0+, iOS 16.0+
private func fetchExtensionLastDisconnectErrorViaIPC(_ session: NETunnelProviderSession) async -> Error? {
  do {
    guard let rpcNameData = ExtensionIPC.fetchLastDetailedJsonError.data(using: .utf8) else {
      return OutlineError.internalError(message: "IPC fetchLastDisconnectError failed")
    }
    return try await withCheckedThrowingContinuation { continuation in
      do {
        DDLogDebug("Calling Extension IPC: \(ExtensionIPC.fetchLastDetailedJsonError)")
        try session.sendProviderMessage(rpcNameData) { data in
          guard let response = data else {
            DDLogDebug("Extension IPC returned with nil error")
            return continuation.resume(returning: nil)
          }
          do {
            let lastError = try PropertyListDecoder().decode(LastErrorIPCData.self, from: response)
            DDLogDebug("Extension IPC returned with \(lastError)")
            continuation.resume(returning: OutlineError.detailedJsonError(code: lastError.errorCode,
                                                                          json: lastError.errorJson))
          } catch {
            continuation.resume(throwing: error)
          }
        }
      } catch {
        continuation.resume(throwing: error)
      }
    }
  } catch {
    DDLogError("Failed to invoke VPN Extension IPC: \(error)")
    return OutlineError.internalError(
      message: "IPC fetchLastDisconnectError failed: \(error.localizedDescription)"
    )
  }
}
