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

import AppKit
import NetworkExtension
import os

/// Logger for the AppKit bridge.
///
/// Use this instead of `NSLog`. `NSLog` writes synchronously to stderr via `writev`, which can
/// block the main thread (and hang the app) when the log pipe is backed up. `os.Logger` is
/// non-blocking.
let appKitBridgeLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "org.outline.macos.client",
    category: "AppKitBridge"
)

@objc
public enum ConnectionStatus: Int {
    case unknown
    case connected
    case disconnected
}

var StatusItem = NSStatusItem()

class StatusItemController: NSObject {
    let connectDisconnectMenuItem = NSMenuItem(title: MenuTitle.connect,
                                               action: #selector(toggleVpnConnection),
                                               keyEquivalent: "c")

    private enum AppIconImage {
        static let statusConnected = getImage(name: "status_bar_button_image_connected")
        static let statusDisconnected = getImage(name: "status_bar_button_image")
    }

    private enum MenuTitle {
        static let open = NSLocalizedString(
            "tray_open_window",
            bundle: Bundle(for: StatusItemController.self),
            comment: "Tray menu entry to show the application window."
        )
        static let quit = NSLocalizedString(
            "quit",
            bundle: Bundle(for: StatusItemController.self),
            comment: "Tray menu entry to quit the application."
        )
        static let connect = NSLocalizedString(
            "connect_button_label",
            bundle: Bundle(for: StatusItemController.self),
            comment: "Menu item to connect to VPN."
        )
        static let disconnect = NSLocalizedString(
            "disconnect_button_label",
            bundle: Bundle(for: StatusItemController.self),
            comment: "Menu item to disconnect from VPN."
        )
    }

    override init() {
        super.init()

        appKitBridgeLogger.info("[StatusItemController] Creating status menu")
        StatusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        setStatus(status: .disconnected)

        let menu = NSMenu()
        let openMenuItem = NSMenuItem(title: MenuTitle.open, action: #selector(openApplication), keyEquivalent: "o")
        openMenuItem.target = self
        menu.addItem(openMenuItem)
        menu.addItem(NSMenuItem.separator())
        connectDisconnectMenuItem.target = self
        menu.addItem(connectDisconnectMenuItem)
        menu.addItem(NSMenuItem.separator())
        let closeMenuItem = NSMenuItem(title: MenuTitle.quit, action: #selector(closeApplication), keyEquivalent: "q")
        closeMenuItem.target = self
        menu.addItem(closeMenuItem)
        StatusItem.menu = menu
    }

    func setStatus(status: ConnectionStatus) {
        appKitBridgeLogger.info("[StatusItemController] Setting status: \(String(describing: status), privacy: .public)")
        let isConnected = status == .connected
        let appIconImage = isConnected ? AppIconImage.statusConnected : AppIconImage.statusDisconnected
        appIconImage.isTemplate = true
        StatusItem.button?.image = appIconImage

        // Update connect/disconnect menu item
        let connectDisconnectTitle = isConnected ? MenuTitle.disconnect : MenuTitle.connect
        connectDisconnectMenuItem.title = connectDisconnectTitle
    }

    @objc func openApplication(_: AnyObject?) {
        appKitBridgeLogger.info("[StatusItemController] Opening application")
        NSApp.activate(ignoringOtherApps: true)
        guard let uiWindow = getUiWindow() else {
            return
        }
        NSApp.setActivationPolicy(.regular)
        uiWindow.makeKeyAndOrderFront(self)
        NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    }

    @objc func closeApplication(_: AnyObject?) {
        appKitBridgeLogger.info("[StatusItemController] Closing application")
        NotificationCenter.default.post(name: Notification.Name("appQuit"), object: nil)
        NSApplication.shared.terminate(self)
    }
    
    @objc func toggleVpnConnection(_ sender: NSMenuItem) {
        appKitBridgeLogger.info("[StatusItemController] Toggle VPN connection")
        
        Task {
            let managers = try? await NETunnelProviderManager.loadAllFromPreferences()
            
            // Early return if no VPN profile exists
            guard let managers = managers, !managers.isEmpty else {
                appKitBridgeLogger.info("[StatusItemController] No VPN profile found, opening app")
                DispatchQueue.main.async {
                    self.openApplication(nil)
                }
                return
            }
            
            guard let manager = managers.first else {
                appKitBridgeLogger.error("[StatusItemController] Failed to get VPN manager")
                return
            }
            
            // Base action purely on menu item title, not current status
            let isConnectAction = sender.title == MenuTitle.connect
            
            if isConnectAction {
                // User clicked "Connect" - attempt to connect regardless of current state
                appKitBridgeLogger.info("[StatusItemController] Connecting to VPN tunnel")
                do {
                    try manager.connection.startVPNTunnel()
                } catch {
                    appKitBridgeLogger.error("[StatusItemController] Failed to connect VPN: \(error.localizedDescription, privacy: .public)")
                    // If connection fails, open the app
                    DispatchQueue.main.async {
                        self.openApplication(nil)
                    }
                }
            } else {
                // User clicked "Disconnect" - attempt to disconnect regardless of current state
                appKitBridgeLogger.info("[StatusItemController] Disconnecting VPN")
                
                // Disable on-demand rules to prevent automatic reconnection, this automatically gets re-enabled if the user clicks the connect button again (regardless of app or menubar)
                do {
                    try await manager.loadFromPreferences()
                    manager.isOnDemandEnabled = false
                    try await manager.saveToPreferences()
                    appKitBridgeLogger.info("[StatusItemController] Disabled on-demand rules")
                } catch {
                    appKitBridgeLogger.error("[StatusItemController] Failed to disable on-demand rules: \(error.localizedDescription, privacy: .public)")
                }
                
                manager.connection.stopVPNTunnel()
            }
        }
    }
}

private func getUiWindow() -> NSWindow? {
    for window in NSApp.windows {
        if String(describing: window).contains("UINSWindow") {
            return window
        }
    }
    return nil
}

private func getImage(name: String) -> NSImage {
    guard let image = Bundle(for: StatusItemController.self).image(forResource: NSImage.Name(name)) else {
        fatalError("Unable to load image asset named \(name).")
    }
    return image
}
