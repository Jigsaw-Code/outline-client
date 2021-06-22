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

import CocoaLumberjack
import CocoaLumberjackSwift
import NetworkExtension
import Sentry

@objcMembers
class OutlinePlugin: CDVPlugin {

  private enum Action {
    static let start = "start"
    static let stop = "stop"
    static let onStatusChange = "onStatusChange"
  }

  public static let kAppQuitNotification = "outlinePluginAppQuitNotification"
  public static let kVpnConnectedNotification = "outlineVpnConnected"
  public static let kVpnDisconnectedNotification = "outlineVpnDisconnected"
  public static let kMaxBreadcrumbs: UInt = 100

  private var callbacks: [String: String]!

#if os(macOS)
  // cordova-osx does not support URL interception. Until it does, we have version-controlled
  // AppDelegate.m (intercept) and Outline-Info.plist (register protocol) to handle ss:// URLs.
  private var urlHandler: CDVMacOsUrlHandler?
  private static let kPlatform = "macOS"
#else
  private static let kPlatform = "iOS"
#endif

  override func pluginInitialize() {
    OutlineSentryLogger.sharedInstance.initializeLogging()

    callbacks = [String: String]()

    OutlineVpn.shared.onVpnStatusChange(onVpnStatusChange)

    #if os(macOS)
      self.urlHandler = CDVMacOsUrlHandler.init(self.webView)
      NotificationCenter.default.addObserver(
          self, selector: #selector(self.stopVpnOnAppQuit),
          name: NSNotification.Name(rawValue: OutlinePlugin.kAppQuitNotification),
          object: nil)
    #endif

    #if os(iOS)
      self.migrateLocalStorage()
    #endif
  }

  /**
   Starts the VPN. This method is idempotent for a given tunnel.
   - Parameters:
    - command: CDVInvokedUrlCommand, where command.arguments
      - tunnelId: string, ID of the tunnel
      - config: [String: Any], represents a server configuration
   */
  func start(_ command: CDVInvokedUrlCommand) {
    guard let tunnelId = command.argument(at: 0) as? String else {
      return sendError("Missing tunnel ID", callbackId: command.callbackId,
                       errorCode: OutlineVpn.ErrorCode.illegalServerConfiguration)
    }
    DDLogInfo("\(Action.start) \(tunnelId)")
    guard let config = command.argument(at: 1) as? [String: Any], containsExpectedKeys(config) else {
      return sendError("Invalid configuration", callbackId: command.callbackId,
                       errorCode: OutlineVpn.ErrorCode.illegalServerConfiguration)
    }
    let tunnel = OutlineTunnel(id: tunnelId, config: config)
    OutlineVpn.shared.start(tunnel) { errorCode in
      if errorCode == OutlineVpn.ErrorCode.noError {
        #if os(macOS)
          NotificationCenter.default.post(
            name: NSNotification.Name(rawValue: OutlinePlugin.kVpnConnectedNotification), object: nil)
        #endif
        self.sendSuccess(callbackId: command.callbackId)
      } else {
        self.sendError("Failed to start VPN", callbackId: command.callbackId,
                       errorCode: errorCode)
      }
    }
  }

  /**
   Stops the VPN. Sends an error if the given tunnel is not running.
   - Parameters:
    - command: CDVInvokedUrlCommand, where command.arguments
      - tunnelId: string, ID of the tunnel
   */
  func stop(_ command: CDVInvokedUrlCommand) {
    guard let tunnelId = command.argument(at: 0) as? String else {
      return sendError("Missing tunnel ID", callbackId: command.callbackId)
    }
    DDLogInfo("\(Action.stop) \(tunnelId)")
    OutlineVpn.shared.stop(tunnelId)
    sendSuccess(callbackId: command.callbackId)
    #if os(macOS)
      NotificationCenter.default.post(
        name: NSNotification.Name(rawValue: OutlinePlugin.kVpnDisconnectedNotification), object: nil)
    #endif
  }

  func isRunning(_ command: CDVInvokedUrlCommand) {
    guard let tunnelId = command.argument(at: 0) as? String else {
      return sendError("Missing tunnel ID", callbackId: command.callbackId)
    }
    DDLogInfo("isRunning \(tunnelId)")
    sendSuccess(OutlineVpn.shared.isActive(tunnelId), callbackId: command.callbackId)
  }

  func isServerReachable(_ command: CDVInvokedUrlCommand) {
    DDLogInfo("isServerReachable")
    guard let host = command.argument(at: 0) as? String else {
      return sendError("Missing host address" , callbackId: command.callbackId)
    }
    guard let port = command.argument(at: 1) as? UInt16 else {
      return sendError("Missing host port", callbackId: command.callbackId)
    }
    OutlineVpn.shared.isServerReachable(host: host, port: port) { errorCode in
      self.sendSuccess(errorCode == OutlineVpn.ErrorCode.noError, callbackId: command.callbackId)
    }
  }

  func onStatusChange(_ command: CDVInvokedUrlCommand) {
    guard let tunnelId = command.argument(at: 0) as? String else {
      return sendError("Missing tunnel ID", callbackId: command.callbackId)
    }
    DDLogInfo("\(Action.onStatusChange) \(tunnelId)")
    setCallbackId(command.callbackId!, action: Action.onStatusChange, tunnelId: tunnelId)
  }

  // MARK: Error reporting

  func initializeErrorReporting(_ command: CDVInvokedUrlCommand) {
    DDLogInfo("initializeErrorReporting")
    guard let apiKey = command.argument(at: 0) as? String else {
      return sendError("Missing error reporting API key.", callbackId: command.callbackId)
    }

    SentrySDK.start { options in
      options.dsn = apiKey
      options.maxBreadcrumbs = OutlinePlugin.kMaxBreadcrumbs
      options.beforeSend = { event in
        // Remove user and device identifiers.
        event.context?["app"]?["device_app_hash"] = ""
        event.user?.userId = ""
        return event
      }
    }
    sendSuccess(true, callbackId: command.callbackId)
  }

  func reportEvents(_ command: CDVInvokedUrlCommand) {
    if !OutlineSentryLogger.isSentryInitialized() {
      sendError("Failed to report events. Sentry not initialized.", callbackId: command.callbackId)
      return
    }
    let event = Event(level: .info)
    var uuid: String
    if let eventId = command.argument(at: 0) as? String {
      // Associate this event with the one reported from JS.
      event.tags = ["user_event_id": eventId]
      uuid = eventId
    } else {
      uuid = NSUUID().uuidString
    }
    event.message = SentryMessage(formatted: "\(OutlinePlugin.kPlatform) report (\(uuid))")

    // Remove device identifier, timezone, and memory stats. Note that we cannot use the
    // beforeSerializeEvent callback, since contexts are only added after serialization
    // if not present.
    let serializedEvent = event.serialize()
    let contexts = serializedEvent["contexts"] as? [String: [String: Any]]
    var appContext = contexts?["app"]
    appContext?["device_app_hash"] = ""
    var deviceContext = contexts?["device"]
    deviceContext?["timezone"] = ""
    deviceContext?["memory_size"] = ""
    deviceContext?["free_memory"] = ""
    deviceContext?["usable_memory"] = ""
    deviceContext?["storage_size"] = ""
    event.context = Context()
    // Setting the sanitized contexts will prevent them from being added on serialization.
    event.context?.appContext = appContext
    event.context?.deviceContext = deviceContext

    OutlineSentryLogger.sharedInstance.addVpnExtensionLogsToSentry()
    // As of sentry-cocoa 5.x, it's no longer possible to set a callback when sending an event,
    // which means that we cannot determine whether the event has been sent successfully.
    // See: https://github.com/getsentry/sentry-cocoa/issues/660
    guard SentrySDK.capture(event: event) != SentryId.empty else {
      self.sendError("Failed to report event", callbackId: command.callbackId)
      return
    }
    self.sendSuccess(true, callbackId: command.callbackId)
  }

#if os(macOS)
  func quitApplication(_ command: CDVInvokedUrlCommand) {
    NSApplication.shared.terminate(self)
  }
#endif

  // MARK: Helpers

  @objc private func stopVpnOnAppQuit() {
    if let activeTunnelId = OutlineVpn.shared.activeTunnelId {
      OutlineVpn.shared.stop(activeTunnelId)
    }
  }

  // Receives NEVPNStatusDidChange notifications. Calls onTunnelStatusChange for the active
  // tunnel.
  func onVpnStatusChange(vpnStatus: NEVPNStatus, tunnelId: String) {
    var tunnelStatus: Int
    switch vpnStatus {
      case .connected:
        #if os(macOS)
          NotificationCenter.default.post(
            name: NSNotification.Name(rawValue: OutlinePlugin.kVpnConnectedNotification), object: nil)
        #endif
        tunnelStatus = OutlineTunnel.TunnelStatus.connected.rawValue
      case .disconnected:
        #if os(macOS)
          NotificationCenter.default.post(
            name: NSNotification.Name(rawValue: OutlinePlugin.kVpnDisconnectedNotification), object: nil)
        #endif
        tunnelStatus = OutlineTunnel.TunnelStatus.disconnected.rawValue
      case .reasserting:
        tunnelStatus = OutlineTunnel.TunnelStatus.reconnecting.rawValue
      default:
        return;  // Do not report transient or invalid states.
    }
    DDLogDebug("Calling onStatusChange (\(tunnelStatus)) for tunnel \(tunnelId)")
    if let callbackId = getCallbackIdFor(action: Action.onStatusChange,
                                         tunnelId: tunnelId,
                                         keepCallback: true) {
      let result = CDVPluginResult(status: CDVCommandStatus_OK, messageAs: Int32(tunnelStatus))
      send(pluginResult: result, callbackId: callbackId, keepCallback: true)
    }
  }

  // Returns whether |config| contains all the expected keys
  private func containsExpectedKeys(_ config: [String: Any]?) -> Bool {
    return config?["host"] != nil && config?["port"] != nil &&
        config?["password"] != nil && config?["method"] != nil
  }

  // MARK: Callback helpers

  private func sendSuccess(callbackId: String, keepCallback: Bool = false) {
    let result = CDVPluginResult(status: CDVCommandStatus_OK)
    send(pluginResult: result, callbackId: callbackId, keepCallback: keepCallback)
  }

  private func sendSuccess(_ operationResult: Bool, callbackId: String, keepCallback: Bool = false) {
    let result = CDVPluginResult(status: CDVCommandStatus_OK, messageAs: operationResult)
    send(pluginResult: result, callbackId: callbackId, keepCallback: keepCallback)
  }

  private func sendError(_ message: String, callbackId: String,
                         errorCode: OutlineVpn.ErrorCode = OutlineVpn.ErrorCode.undefined,
                         keepCallback: Bool = false) {
    DDLogError(message)
    let result = CDVPluginResult(status: CDVCommandStatus_ERROR,
                                 messageAs: Int32(errorCode.rawValue))
    send(pluginResult: result, callbackId: callbackId, keepCallback: keepCallback)
  }

  private func send(pluginResult: CDVPluginResult?, callbackId: String, keepCallback: Bool) {
    guard let result = pluginResult else {
      return DDLogWarn("Missing plugin result");
    }
    result.setKeepCallbackAs(keepCallback)
    self.commandDelegate?.send(result, callbackId: callbackId)
  }

  // Maps |action| and |tunnelId| to |callbackId| in the callbacks dictionary.
  private func setCallbackId(_ callbackId: String, action: String, tunnelId: String) {
    DDLogDebug("\(action):\(tunnelId):\(callbackId)")
    callbacks["\(action):\(tunnelId)"] = callbackId
  }

  // Retrieves the callback ID for |action| and |tunnelId|. Unmaps the entry if |keepCallback|
  // is false.
  private func getCallbackIdFor(action: String, tunnelId: String?,
                                keepCallback: Bool = false) -> String? {
    guard let tunnelId = tunnelId else {
      return nil
    }
    let key = "\(action):\(tunnelId)"
    guard let callbackId = callbacks[key] else {
      DDLogWarn("Callback id not found for action \(action) and tunnel \(tunnelId)")
      return nil
    }
    if (!keepCallback) {
      callbacks.removeValue(forKey: key)
    }
    return callbackId
  }

  // Migrates local storage files from UIWebView to WKWebView.
  private func migrateLocalStorage() {
    // Local storage backing files have the following naming format: $scheme_$hostname_$port.localstorage
    // With UIWebView, the app used the file:// scheme with no hostname and any port.
    let kUIWebViewLocalStorageFilename = "file__0.localstorage"
    // With WKWebView, the app uses the app:// scheme with localhost as a hostname and any port.
    let kWKWebViewLocalStorageFilename = "app_localhost_0.localstorage"

    let fileManager = FileManager.default
    let appLibraryDir = fileManager.urls(for: .libraryDirectory, in: .userDomainMask)[0]

    var uiWebViewLocalStorageDir: URL
    if fileManager.fileExists(atPath: appLibraryDir.appendingPathComponent(
        "WebKit/LocalStorage/\(kUIWebViewLocalStorageFilename)").relativePath) {
      uiWebViewLocalStorageDir = appLibraryDir.appendingPathComponent("WebKit/LocalStorage")
    } else {
      uiWebViewLocalStorageDir = appLibraryDir.appendingPathComponent("Caches")
    }
    let uiWebViewLocalStorage = uiWebViewLocalStorageDir.appendingPathComponent(kUIWebViewLocalStorageFilename)
    if !fileManager.fileExists(atPath: uiWebViewLocalStorage.relativePath) {
      return DDLogInfo("Not migrating, UIWebView local storage files missing.")
    }

    let wkWebViewLocalStorageDir = appLibraryDir.appendingPathComponent("WebKit/WebsiteData/LocalStorage/")
    let wkWebViewLocalStorage = wkWebViewLocalStorageDir.appendingPathComponent(kWKWebViewLocalStorageFilename)
    // Only copy the local storage files if they don't exist for WKWebView.
    if fileManager.fileExists(atPath: wkWebViewLocalStorage.relativePath) {
      return DDLogInfo("Not migrating, WKWebView local storage files present.")
    }
    DDLogInfo("Migrating UIWebView local storage to WKWebView")

    // Create the WKWebView local storage directory; this is safe if the directory already exists.
    do {
      try fileManager.createDirectory(at: wkWebViewLocalStorageDir, withIntermediateDirectories: true)
    } catch {
      return DDLogError("Failed to create WKWebView local storage directory")
    }

    // Create a tmp directory and copy onto it the local storage files.
    guard let tmpDir = try? fileManager.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                            appropriateFor: wkWebViewLocalStorage, create: true) else {
      return DDLogError("Failed to create tmp dir")
    }
    do {
      try fileManager.copyItem(at: uiWebViewLocalStorage,
                               to: tmpDir.appendingPathComponent(wkWebViewLocalStorage.lastPathComponent))
      try fileManager.copyItem(at: URL.init(fileURLWithPath: "\(uiWebViewLocalStorage.relativePath)-shm"),
                               to: tmpDir.appendingPathComponent("\(kWKWebViewLocalStorageFilename)-shm"))
      try fileManager.copyItem(at: URL.init(fileURLWithPath: "\(uiWebViewLocalStorage.relativePath)-wal"),
                               to: tmpDir.appendingPathComponent("\(kWKWebViewLocalStorageFilename)-wal"))
    } catch {
      return DDLogError("Local storage migration failed.")
    }

    // Atomically move the tmp directory to the WKWebView local storage directory.
    guard let _ = try? fileManager.replaceItemAt(wkWebViewLocalStorageDir, withItemAt: tmpDir,
                                                 backupItemName: nil, options: .usingNewMetadataOnly) else {
      return DDLogError("Failed to copy tmp dir to WKWebView local storage dir")
    }

    DDLogInfo("Local storage migration succeeded")
  }
}
