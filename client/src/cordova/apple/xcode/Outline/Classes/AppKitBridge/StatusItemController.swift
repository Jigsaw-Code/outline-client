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
    private var isQuitting = false
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
        let closeMenuItem = NSMenuItem(title: MenuTitle.quit, action: #selector(closeApplication), keyEquivalent: "")
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
        NSApp.setActivationPolicy(.regular)
        NSApp.unhide(nil)
        if let window = NSApp.windows.first(where: { $0.className == "UINSWindow" }) {
            window.makeKeyAndOrderFront(self)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        // If Catalyst discarded the window, ask it to restore the scene.
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration)
    }

    func connectOnLogin() {
        Task { @MainActor in
            do {
                guard let manager = try await NETunnelProviderManager.loadAllFromPreferences().first,
                    !isQuitting, manager.isEnabled, manager.isOnDemandEnabled,
                    manager.connection.status == .disconnected else { return }
                try manager.connection.startVPNTunnel()
            } catch {
                NSLog("[StatusItemController] Login connection failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func closeApplication(_: AnyObject?) {
        guard !isQuitting else { return }
        isQuitting = true
        Task { @MainActor in
            do {
                if let manager = try await NETunnelProviderManager.loadAllFromPreferences().first {
                    try await disconnect(manager)
                }
                NSApplication.shared.terminate(self)
            } catch {
                isQuitting = false
                NSLog("[StatusItemController] Unable to disconnect before quitting: \(error.localizedDescription)")
                let alert = NSAlert(error: error)
                alert.runModal()
            }
        }
    }

    private func disconnect(_ manager: NETunnelProviderManager) async throws {
        var preferenceError: Error?
        do {
            try await manager.loadFromPreferences()
            manager.isOnDemandEnabled = false
            try await manager.saveToPreferences()
        } catch {
            preferenceError = error
        }
        // Honor Disconnect even if disabling automatic reconnect failed.
        manager.connection.stopVPNTunnel()
        if let preferenceError {
            // Report the failure and keep Quit from exiting with on-demand still enabled.
            throw preferenceError
        }
        // Wait for the system extension, but keep the app available on failure.
        for _ in 0..<100 {
            if manager.connection.status == .disconnected || manager.connection.status == .invalid {
                return
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(ETIMEDOUT),
            userInfo: [NSLocalizedDescriptionKey: NSLocalizedString(
                "Outline could not disconnect the VPN. Please try again before quitting.",
                comment: "Shown when quitting cannot finish disconnecting the VPN.")])
    }

    @objc func toggleVpnConnection(_ sender: NSMenuItem) {
        guard !isQuitting else { return }
        NSLog("[StatusItemController] Toggle VPN connection")
        
        Task { @MainActor in
            let managers = try? await NETunnelProviderManager.loadAllFromPreferences()
            
            // Early return if no VPN profile exists
            guard let managers = managers, !managers.isEmpty else {
                NSLog("[StatusItemController] No VPN profile found, opening app")
                self.openApplication(nil)
                return
            }
            
            guard !isQuitting else { return }
            guard let manager = managers.first else {
                NSLog("[StatusItemController] Failed to get VPN manager")
                return
            }
            
            // Base action purely on menu item title, not current status
            let isConnectAction = sender.title == MenuTitle.connect
            
            if isConnectAction {
                // User clicked "Connect" - attempt to connect regardless of current state
                NSLog("[StatusItemController] Connecting to VPN tunnel")
                do {
                    try manager.connection.startVPNTunnel()
                } catch {
                    NSLog("[StatusItemController] Failed to connect VPN: \(error.localizedDescription)")
                    // If connection fails, open the app
                    self.openApplication(nil)
                }
            } else {
                // User clicked "Disconnect" - attempt to disconnect regardless of current state
                NSLog("[StatusItemController] Disconnecting VPN")
                
                do {
                    try await disconnect(manager)
                } catch {
                    NSLog("[StatusItemController] Failed to disconnect VPN: \(error.localizedDescription)")
                    let alert = NSAlert(error: error)
                    alert.runModal()
                }
            }
        }
    }
}

private func getImage(name: String) -> NSImage {
    guard let image = Bundle(for: StatusItemController.self).image(forResource: NSImage.Name(name)) else {
        fatalError("Unable to load image asset named \(name).")
    }
    return image
}
