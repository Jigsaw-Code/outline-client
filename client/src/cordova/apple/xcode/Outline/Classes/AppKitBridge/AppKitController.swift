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
import ServiceManagement

class AppKitController: NSObject {
    private var statusItemController: StatusItemController?
    private var lastConnectionStatus: ConnectionStatus?
    private var windowCloseObserver: NSObjectProtocol?

    override public required init() {
        super.init()

        // Indicates that the application is an ordinary app that appears in the Dock and may have a user interface.
        NSApp.setActivationPolicy(.regular)
        
        // Set up window close observer to hide Dock icon when main window is closed
        setupWindowCloseObserver()
    }
    
    deinit {
        if let observer = windowCloseObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        NotificationCenter.default.removeObserver(
            self, name: NSApplication.didBecomeActiveNotification, object: nil)
    }
    
    private func setupWindowCloseObserver() {
        windowCloseObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let window = notification.object as? NSWindow else { return }
            
            // Check if this is the main UI window
            if self?.isMainUiWindow(window) == true {
                self?.hideDockIcon()
            }
        }
        
        // Restore the Dock icon when the app becomes active again (e.g. the main
        // window is reopened after being closed).
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func appDidBecomeActive() {
        // Show Dock icon when app becomes active
        showDockIcon()
    }

    private func hideDockIcon() {
        // Hide the Dock icon when the main window is closed.
        //
        // This is only triggered by NSWindow.willCloseNotification, never by
        // didResignActive: switching to .accessory deactivates the app and sends
        // its window behind other apps. During launch the main UINSWindow isn't
        // reliably visible yet, so hiding on an early resign-active made the
        // window "disappear" behind other windows.
        NSApp.setActivationPolicy(.accessory)
    }
    
    private func showDockIcon() {
        // Show the Dock icon when the main window becomes active
        NSApp.setActivationPolicy(.regular)
    }
    
    /// Determines if the given window is the main UI window.
    ///
    /// Match the Catalyst content window class exactly ("UINSWindow"). A substring
    /// match is wrong here: during launch Catalyst also creates and destroys a
    /// transient, non-visible "TUINSWindow", whose name *contains* "UINSWindow".
    /// Treating that transient window's close as the main window closing flipped
    /// the app to .accessory and sent the real (still-visible) window behind other
    /// apps on launch.
    /// TODO: Decouple from the internal class name "UINSWindow" in the future
    private func isMainUiWindow(_ window: NSWindow) -> Bool {
        return window.className == "UINSWindow"
    }

    /// Set the connection status in the app's menu in the system-wide menu bar.
    @objc public func _AppKitBridge_setConnectionStatus(_ status: ConnectionStatus) {
        // VPN status notifications may be delivered on any thread. Serialize the
        // dedup check and the menu update on the main thread so `lastConnectionStatus`
        // always matches what the menu is actually showing (AppKit also requires
        // UI updates on the main thread).
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in
                self?._AppKitBridge_setConnectionStatus(status)
            }
            return
        }
        if statusItemController == nil {
            appKitBridgeLogger.info("[AppKitController] No status item controller found. Creating one now.")
            statusItemController = StatusItemController()
        } else if lastConnectionStatus == status {
            // Skip redundant main-thread updates when the status hasn't changed.
            return
        }
        lastConnectionStatus = status
        statusItemController!.setStatus(status: status)
    }
}
