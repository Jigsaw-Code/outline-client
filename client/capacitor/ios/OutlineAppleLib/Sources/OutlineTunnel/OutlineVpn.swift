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
    if let manager = await getTunnelManager(), isActiveSession(manager.connection) {
      DDLogDebug("Stoppping active session before starting new one")
      await stopSession(manager)
    }

    let manager: NETunnelProviderManager
    do {
      manager = try await setupVpn(withId: tunnelId, named: name ?? "Outline Server", withTransport: transportConfig)
    } catch {
      DDLogError("Failed to setup VPN: \(error.localizedDescription)")
      throw OutlineError.vpnPermissionNotGranted(cause: error)
    }
    let session = manager.connection as! NETunnelProviderSession

    // Register observer for start process completion.
    class TokenHolder {
      var token: NSObjectProtocol?
    }
    let tokenHolder = TokenHolder()
      let startDone = Task {
          await withCheckedContinuation { continuation in
              tokenHolder.token = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: manager.connection, queue: nil) { notification in
                  // The notification object is always the session, so we can rely on that to not be nil.
                  guard let connection = notification.object as? NETunnelProviderSession else {
                      DDLogDebug("Failed to cast notification.object to NETunnelProviderSession")
                      return
                  }
                  
                  let status = connection.status
                  DDLogDebug("OutlineVpn.start got status \(String(describing: status)), notification: \(String(describing: notification))")
                  // The observer may be triggered multiple times, but we only remove it when we reach an end state.
                  // A successful connection will go through .connecting -> .disconnected
                  // A failed connection will go through .connecting -> .disconnecting -> .disconnected
                  // An .invalid event may happen if the configuration is modified and ends in an invalid state.
                  if status == .connected || status == .disconnected || status == .invalid {
                      DDLogDebug("Tunnel start done.")
                      if let token = tokenHolder.token {
                          NotificationCenter.default.removeObserver(token, name: .NEVPNStatusDidChange, object: connection)
                      }
                      continuation.resume()
                  }
              }
          }
      }

    // Start the session.
    do {
      DDLogDebug("Calling NETunnelProviderSession.startTunnel([:])")
      try session.startTunnel(options: [:])
      DDLogDebug("NETunnelProviderSession.startTunnel() returned")
    } catch {
      DDLogError("Failed to start VPN: \(error.localizedDescription)")
      throw OutlineError.setupSystemVPNFailed(cause: error)
    }

    // Wait for it to be done.
    await startDone.value

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
    do { try await manager.saveToPreferences() }
    catch {
      DDLogWarn("OutlineVpn.start: Failed to save on-demand preference change: \(error.localizedDescription)")
    }
  }

  /** Tears down the VPN if the tunnel with id |tunnelId| is active. */
  public func stop(_ tunnelId: String) async {
    guard let manager = await getTunnelManager(),
          getTunnelId(forManager: manager) == tunnelId,
          isActiveSession(manager.connection) else {
      DDLogWarn("Trying to stop tunnel \(tunnelId) that is not running")
      return
    }
    await stopSession(manager)
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
      ConfigKey.transport: transportConfig
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
    if isActiveSession(session) {
      Task {
        await setConnectVpnOnDemand(manager, true)
      }
    }
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

private func stopSession(_ manager:NETunnelProviderManager) async {
  do {
    try await manager.loadFromPreferences()
    await setConnectVpnOnDemand(manager, false) // Disable on demand so the VPN does not connect automatically.
    manager.connection.stopVPNTunnel()
    // Wait for stop to be completed.
    class TokenHolder {
      var token: NSObjectProtocol?
    }
    let tokenHolder = TokenHolder()
    await withCheckedContinuation { continuation in
      tokenHolder.token = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: manager.connection, queue: nil) { notification in
        if manager.connection.status == .disconnected {
          DDLogDebug("Tunnel stopped. Ready to start again.")
          if let token = tokenHolder.token {
            NotificationCenter.default.removeObserver(token, name: .NEVPNStatusDidChange, object: manager.connection)
          }
          continuation.resume()
        }
      }
    }
  } catch {
    DDLogWarn("Failed to stop VPN")
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
