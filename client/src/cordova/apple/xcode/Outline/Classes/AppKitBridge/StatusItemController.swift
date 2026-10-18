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

        NSLog("[StatusItemController] Creating status menu")
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
        NSLog("[StatusItemController] Setting status: \(status)")
        let isConnected = status == .connected
        let appIconImage = isConnected ? AppIconImage.statusConnected : AppIconImage.statusDisconnected
        appIconImage.isTemplate = true
        StatusItem.button?.image = appIconImage

        // Update connect/disconnect menu item
        let connectDisconnectTitle = isConnected ? MenuTitle.disconnect : MenuTitle.connect
        connectDisconnectMenuItem.title = connectDisconnectTitle
    }

    @objc func openApplication(_: AnyObject?) {
        NSLog("[StatusItemController] Opening application")
        NSApp.activate(ignoringOtherApps: true)
        guard let uiWindow = getUiWindow() else {
            return
        }
        NSApp.setActivationPolicy(.regular)
        uiWindow.makeKeyAndOrderFront(self)
        NSRunningApplication.current.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    }

    @objc func closeApplication(_: AnyObject?) {
        NSLog("[StatusItemController] Closing application")
        NotificationCenter.default.post(name: Notification.Name("appQuit"), object: nil)
        NSApplication.shared.terminate(self)
    }
    
    @objc func toggleVpnConnection(_ sender: NSMenuItem) {
        let action = sender.title == MenuTitle.connect ? "connect" : "disconnect"
        Task {
            let managers = try? await NETunnelProviderManager.loadAllFromPreferences()
            guard let manager = managers?.first,
                  let config = manager.protocolConfiguration as? NETunnelProviderProtocol,
                  let serverId = config.providerConfiguration?["id"] as? String else {
                DispatchQueue.main.async { self.openApplication(nil) }
                return
            }
            // Use the same user-intent and operation queue as the GUI and CLI.
            DispatchQueue.main.async {
                NotificationCenter.default.post(
                    name: Notification.Name("outlineControlMenuCommand"), object: nil,
                    userInfo: ["action": action, "server": serverId]
                )
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
