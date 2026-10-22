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
import OutlineError
import OutlineNotification
import OutlineSentryLogger
import OutlineTunnel
import Sentry
import Tun2socks
#if os(iOS) && !targetEnvironment(macCatalyst)
  import WidgetKit
#endif

public enum TunnelStatus: Int {
  case connected = 0
  case disconnected = 1
  case reconnecting = 2
  case disconnecting = 3
}

@objcMembers
class OutlinePlugin: CDVPlugin {

  private enum Action {
    static let start = "start"
    static let stop = "stop"
    static let onStatusChange = "onStatusChange"
  }

  public static let kMaxBreadcrumbs: UInt = 100

  private var sentryLogger: OutlineSentryLogger!
  private var statusCallbackId: String?

  #if os(macOS) || targetEnvironment(macCatalyst)
    private static let kPlatform = "macOS"
  #else
    private static let kPlatform = "iOS"
  #endif
  private static let kAppGroup = "group.org.getoutline.client"

  private func reloadOutlineControls() {
    #if os(iOS) && !targetEnvironment(macCatalyst)
      if #available(iOS 18.0, *) {
        ControlCenter.shared.reloadControls(ofKind: OutlineControlKind.vpnToggle)
      }
    #endif
  }

  override func pluginInitialize() {
    #if DEBUG
      dynamicLogLevel = .all
    #else
      dynamicLogLevel = .info
    #endif
    self.sentryLogger = OutlineSentryLogger(
      forAppGroup: OutlinePlugin.kAppGroup
    )
    OutlineVpn.shared.onVpnStatusChange(onVpnStatusChange)

    #if os(macOS)
      // cordova-osx does not support URL interception. Until it does, we have version-controlled
      // AppDelegate.m (intercept) and Outline-Info.plist (register protocol) to handle ss:// URLs.
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.handleOpenUrl),
        name: .kHandleUrl,
        object: nil
      )
    #endif

    #if os(macOS) || targetEnvironment(macCatalyst)
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.stopVpnOnAppQuit),
        name: .kAppQuit,
        object: nil
      )
    #endif

    #if os(iOS)
      self.migrateLocalStorage()
    #endif

    if let goConfig = OutlineGetBackendConfig() {
      do {
        goConfig.dataDir = try FileManager.default.url(
          for: .applicationSupportDirectory,
          in: .userDomainMask,
          appropriateFor: nil,
          create: true
        ).path
      } catch {
        DDLogWarn("Error finding Application Support directory: \(error)")
      }
    }
  }

  /**
    Starts the VPN. This method is idempotent for a given tunnel.
    - Parameters:
    - command: CDVInvokedUrlCommand, where command.arguments
    - tunnelId: string, ID of the tunnel
    - config: [String: Any], represents a server configuration
    */
  func start(_ command: CDVInvokedUrlCommand) {
    Task {
      do {
        guard let tunnelId = command.argument(at: 0) as? String else {
          throw OutlineError.internalError(
            message: "missing tunnel ID"
          )
        }
        guard let name = command.argument(at: 1) as? String else {
          throw OutlineError.internalError(
            message: "missing service name"
          )
        }
        DDLogInfo("\(Action.start) \(name) (\(tunnelId))")
        guard let transportConfig = command.argument(at: 2) as? String
        else {
          throw OutlineError.internalError(
            message: "configuration is not a string"
          )
        }
        try await OutlineVpn.shared.start(
          tunnelId,
          named: name,
          withTransport: transportConfig
        )
        reloadOutlineControls()
        #if os(macOS) || targetEnvironment(macCatalyst)
          NotificationCenter.default.post(
            name: .kVpnConnected,
            object: nil
          )
        #endif
        self.sendSuccess(callbackId: command.callbackId)
      } catch {
        self.sendError(
          marshalErrorJson(error: error),
          callbackId: command.callbackId
        )
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
      return sendError(
        "Missing tunnel ID",
        callbackId: command.callbackId
      )
    }
    DDLogInfo("\(Action.stop) \(tunnelId)")
    Task {
      await OutlineVpn.shared.stop(tunnelId)
      reloadOutlineControls()
      sendSuccess(callbackId: command.callbackId)
      #if os(macOS) || targetEnvironment(macCatalyst)
        NotificationCenter.default.post(
          name: .kVpnDisconnected,
          object: nil
        )
      #endif
    }

  }

  func isRunning(_ command: CDVInvokedUrlCommand) {
    guard let tunnelId = command.argument(at: 0) as? String else {
      return sendError(
        "Missing tunnel ID",
        callbackId: command.callbackId
      )
    }
    DDLogInfo("isRunning \(tunnelId)")
    Task {
      self.sendSuccess(
        await OutlineVpn.shared.isActive(tunnelId),
        callbackId: command.callbackId
      )
    }
  }

  func invokeMethod(_ command: CDVInvokedUrlCommand) {
    guard let methodName = command.argument(at: 0) as? String else {
      return sendError(
        "Missing method name",
        callbackId: command.callbackId
      )
    }
    guard let input = command.argument(at: 1) as? String else {
      return sendError(
        "Missing method input",
        callbackId: command.callbackId
      )
    }
    DDLogDebug("Invoking Method \(methodName) with input \(input)")
    Task {
      guard let result = OutlineInvokeMethod(methodName, input) else {
        DDLogDebug("InvokeMethod \(methodName) got nil result")
        return self.sendError(
          "unexpected invoke error",
          callbackId: command.callbackId
        )
      }
      if result.error != nil {
        let errorJson = marshalErrorJson(
          error: OutlineError.platformError(result.error!)
        )
        DDLogDebug(
          "InvokeMethod \(methodName) failed with error \(errorJson)"
        )
        return self.sendError(errorJson, callbackId: command.callbackId)
      }
      DDLogDebug("InvokeMethod result: \(result.value)")
      self.sendSuccess(result.value, callbackId: command.callbackId)
    }
  }

  func onStatusChange(_ command: CDVInvokedUrlCommand) {
    DDLogInfo("OutlinePlugin: registering status callback")
    if let currentCallbackId = self.statusCallbackId {
      self.removeCallback(withId: currentCallbackId)
      self.statusCallbackId = nil
    }
    if let newCallbackId = command.callbackId {
      self.statusCallbackId = newCallbackId
    }
  }

  // MARK: - Error reporting

  func initializeErrorReporting(_ command: CDVInvokedUrlCommand) {
    DDLogInfo("initializeErrorReporting")
    guard let sentryDsn = command.argument(at: 0) as? String else {
      return sendError(
        "Missing error reporting API key.",
        callbackId: command.callbackId
      )
    }
    SentrySDK.start { options in
      options.dsn = sentryDsn
      options.maxBreadcrumbs = UInt(OutlinePlugin.kMaxBreadcrumbs)
      // Remove device identifier, timezone, and memory stats.
      options.beforeSend = { event in
        event.context?["app"]?.removeValue(forKey: "device_app_hash")
        if var device = event.context?["device"] {
          device.removeValue(forKey: "timezone")
          device.removeValue(forKey: "memory_size")
          device.removeValue(forKey: "free_memory")
          device.removeValue(forKey: "usable_memory")
          device.removeValue(forKey: "storage_size")
          event.context?["device"] = device
        }
        return event
      }
    }
    sendSuccess(true, callbackId: command.callbackId)
  }

  func reportEvents(_ command: CDVInvokedUrlCommand) {
    var uuid: String
    if let eventId = command.argument(at: 0) as? String {
      // Associate this event with the one reported from JS.
      SentrySDK.configureScope { scope in
        scope.setTag(value: eventId, key: "user_event_id")
      }
      uuid = eventId
    } else {
      uuid = NSUUID().uuidString
    }
    self.sentryLogger.addVpnExtensionLogsToSentry(
      maxBreadcrumbsToAdd: Int(OutlinePlugin.kMaxBreadcrumbs / 2)
    )
    SentrySDK.capture(
      message: "\(OutlinePlugin.kPlatform) report (\(uuid))"
    ) { scope in
      scope.setLevel(.info)
    }
    self.sendSuccess(true, callbackId: command.callbackId)
  }

  #if os(macOS)
    func quitApplication(_ command: CDVInvokedUrlCommand) {
      NSApplication.shared.terminate(self)
    }
  #endif

  // MARK: - Helpers

  #if os(macOS)
    @objc private func handleOpenUrl(_ notification: Notification) {
      guard let url = notification.object as? String else {
        return NSLog("Received non-String object.")
      }
      NSLog("Intercepted URL.")
      guard let urlJson = try? JSONEncoder().encode(url),
        let encodedUrl = String(data: urlJson, encoding: .utf8)
      else {
        return NSLog("Failed to JS-encode intercepted URL")
      }
      DispatchQueue.global(qos: .background).async {
        while self.webView.isLoading {
          // Wait until the page is loaded in case the app launched with the intercepted URL.
          Thread.sleep(forTimeInterval: 0.5)
        }
        DispatchQueue.main.async {
          let handleOpenUrlJs = """
            document.addEventListener('deviceready', function() {
                if (typeof handleOpenURL === 'function') {
                    handleOpenURL(\(encodedUrl));
                }
            });
            """
          self.webView.stringByEvaluatingJavaScript(
            from: handleOpenUrlJs
          )
        }
      }
    }
  #endif

  @objc private func stopVpnOnAppQuit() {
    Task {
      await OutlineVpn.shared.stopActiveVpn()
    }
  }

  // Receives NEVPNStatusDidChange notifications. Calls onTunnelStatusChange for the active
  // tunnel.
  func onVpnStatusChange(vpnStatus: NEVPNStatus, tunnelId: String) {
    DDLogDebug(
      "OutlinePlugin received onStatusChange (\(String(describing: vpnStatus))) for tunnel \(tunnelId)"
    )
    switch vpnStatus {
    case .connected, .disconnected, .disconnecting, .reasserting, .connecting:
      reloadOutlineControls()
    default:
      break
    }
    guard let callbackId = self.statusCallbackId else {
      // No status change callback registered.
      return
    }
    var tunnelStatus: Int
    switch vpnStatus {
    case .connected:
      #if os(macOS) || targetEnvironment(macCatalyst)
        NotificationCenter.default.post(
          name: .kVpnConnected,
          object: nil
        )
      #endif
      tunnelStatus = TunnelStatus.connected.rawValue
    case .disconnected:
      #if os(macOS) || targetEnvironment(macCatalyst)
        NotificationCenter.default.post(
          name: .kVpnDisconnected,
          object: nil
        )
      #endif
      tunnelStatus = TunnelStatus.disconnected.rawValue
    case .disconnecting:
      tunnelStatus = TunnelStatus.disconnecting.rawValue
    case .reasserting:
      tunnelStatus = TunnelStatus.reconnecting.rawValue
    case .connecting:
      tunnelStatus = TunnelStatus.reconnecting.rawValue
    default:
      return  // Do not report transient or invalid states.
    }
    let result = CDVPluginResult(
      status: CDVCommandStatus_OK,
      messageAs: ["id": tunnelId, "status": Int32(tunnelStatus)]
    )
    self.send(
      pluginResult: result,
      callbackId: callbackId,
      keepCallback: true
    )
  }

  // MARK: - Callback helpers

  private func sendSuccess(callbackId: String, keepCallback: Bool = false) {
    let result = CDVPluginResult(status: CDVCommandStatus_OK)
    self.send(
      pluginResult: result,
      callbackId: callbackId,
      keepCallback: keepCallback
    )
  }

  private func sendSuccess(
    _ operationResult: String,
    callbackId: String,
    keepCallback: Bool = false
  ) {
    let result = CDVPluginResult(
      status: CDVCommandStatus_OK,
      messageAs: operationResult
    )
    self.send(
      pluginResult: result,
      callbackId: callbackId,
      keepCallback: keepCallback
    )
  }

  private func sendSuccess(
    _ operationResult: Bool,
    callbackId: String,
    keepCallback: Bool = false
  ) {
    let result = CDVPluginResult(
      status: CDVCommandStatus_OK,
      messageAs: operationResult
    )
    self.send(
      pluginResult: result,
      callbackId: callbackId,
      keepCallback: keepCallback
    )
  }

  private func sendError(
    _ message: String,
    callbackId: String,
    keepCallback: Bool = false
  ) {
    DDLogWarn("plugin result error: \(message)")
    let result = CDVPluginResult(
      status: CDVCommandStatus_ERROR,
      messageAs: message
    )
    self.send(
      pluginResult: result,
      callbackId: callbackId,
      keepCallback: keepCallback
    )
  }

  private func send(
    pluginResult: CDVPluginResult?,
    callbackId: String,
    keepCallback: Bool
  ) {
    guard let result = pluginResult else {
      return DDLogWarn("Missing plugin result")
    }
    result.setKeepCallbackAs(keepCallback)
    self.commandDelegate?.send(result, callbackId: callbackId)
  }

  private func removeCallback(withId callbackId: String) {
    guard let result = CDVPluginResult(status: CDVCommandStatus_NO_RESULT)
    else {
      return DDLogWarn("Missing plugin result for callback \(callbackId)")
    }
    result.setKeepCallbackAs(false)
    self.commandDelegate?.send(result, callbackId: callbackId)
  }

  // Migrates local storage files from UIWebView to WKWebView.
  private func migrateLocalStorage() {
    // Local storage backing files have the following naming format: $scheme_$hostname_$port.localstorage
    // With UIWebView, the app used the file:// scheme with no hostname and any port.
    let kUIWebViewLocalStorageFilename = "file__0.localstorage"
    // With WKWebView, the app uses the app:// scheme with localhost as a hostname and any port.
    let kWKWebViewLocalStorageFilename = "app_localhost_0.localstorage"

    let fileManager = FileManager.default
    let appLibraryDir = fileManager.urls(
      for: .libraryDirectory,
      in: .userDomainMask
    )[0]

    let uiWebViewLocalStorageDir: URL
    #if targetEnvironment(macCatalyst)
      guard let bundleID = Bundle.main.bundleIdentifier else {
        return DDLogError("Unable to get bundleID for app.")
      }
      let appSupportDir = fileManager.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      )[0]
      uiWebViewLocalStorageDir = appSupportDir.appendingPathComponent(
        bundleID
      )
    #else
      if fileManager.fileExists(
        atPath: appLibraryDir.appendingPathComponent(
          "WebKit/LocalStorage/\(kUIWebViewLocalStorageFilename)"
        ).relativePath
      ) {
        uiWebViewLocalStorageDir = appLibraryDir.appendingPathComponent(
          "WebKit/LocalStorage"
        )
      } else {
        uiWebViewLocalStorageDir = appLibraryDir.appendingPathComponent(
          "Caches"
        )
      }
    #endif
    let uiWebViewLocalStorage =
      uiWebViewLocalStorageDir.appendingPathComponent(
        kUIWebViewLocalStorageFilename
      )
    if !fileManager.fileExists(atPath: uiWebViewLocalStorage.relativePath) {
      return DDLogInfo(
        "Not migrating, UIWebView local storage files missing."
      )
    }

    let wkWebViewLocalStorageDir = appLibraryDir.appendingPathComponent(
      "WebKit/WebsiteData/LocalStorage/"
    )
    let wkWebViewLocalStorage =
      wkWebViewLocalStorageDir.appendingPathComponent(
        kWKWebViewLocalStorageFilename
      )
    // Only copy the local storage files if they don't exist for WKWebView.
    if fileManager.fileExists(atPath: wkWebViewLocalStorage.relativePath) {
      return DDLogInfo(
        "Not migrating, WKWebView local storage files present."
      )
    }
    DDLogInfo("Migrating UIWebView local storage to WKWebView")

    // Create the WKWebView local storage directory; this is safe if the directory already exists.
    do {
      try fileManager.createDirectory(
        at: wkWebViewLocalStorageDir,
        withIntermediateDirectories: true
      )
    } catch {
      return DDLogError(
        "Failed to create WKWebView local storage directory"
      )
    }

    // Create a tmp directory and copy onto it the local storage files.
    guard
      let tmpDir = try? fileManager.url(
        for: .itemReplacementDirectory,
        in: .userDomainMask,
        appropriateFor: wkWebViewLocalStorage,
        create: true
      )
    else {
      return DDLogError("Failed to create tmp dir")
    }
    do {
      try fileManager.copyItem(
        at: uiWebViewLocalStorage,
        to: tmpDir.appendingPathComponent(
          wkWebViewLocalStorage.lastPathComponent
        )
      )
      try fileManager.copyItem(
        at: URL.init(
          fileURLWithPath: "\(uiWebViewLocalStorage.relativePath)-shm"
        ),
        to: tmpDir.appendingPathComponent(
          "\(kWKWebViewLocalStorageFilename)-shm"
        )
      )
      try fileManager.copyItem(
        at: URL.init(
          fileURLWithPath: "\(uiWebViewLocalStorage.relativePath)-wal"
        ),
        to: tmpDir.appendingPathComponent(
          "\(kWKWebViewLocalStorageFilename)-wal"
        )
      )
    } catch {
      return DDLogError("Local storage migration failed.")
    }

    // Atomically move the tmp directory to the WKWebView local storage directory.
    guard
      (try? fileManager.replaceItemAt(
        wkWebViewLocalStorageDir,
        withItemAt: tmpDir,
        backupItemName: nil,
        options: .usingNewMetadataOnly
      )) != nil
    else {
      return DDLogError(
        "Failed to copy tmp dir to WKWebView local storage dir"
      )
    }

    DDLogInfo("Local storage migration succeeded")
  }
}
