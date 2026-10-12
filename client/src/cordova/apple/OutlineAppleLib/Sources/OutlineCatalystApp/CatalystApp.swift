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

#if targetEnvironment(macCatalyst)

    import CocoaLumberjack
    import CocoaLumberjackSwift
    import Foundation
    import OutlineNotification
    import ServiceManagement

    @objcMembers
    public class OutlineCatalystApp: NSObject {
        public static func initApp() {
            DDLog.add(DDOSLogger.sharedInstance)

            let appKitController = loadAppKitIntegrationFramework()

            // Configure the window.
            let scenes = UIApplication.shared.connectedScenes
            for scene in scenes {
                let windowScene = (scene as! UIWindowScene)
                windowScene.titlebar?.titleVisibility = .hidden
                windowScene.titlebar?.toolbar = nil
                windowScene.sizeRestrictions?.minimumSize = CGSizeMake(400, 680)
                windowScene.sizeRestrictions?.maximumSize = CGSizeMake(400, 680)
            }

            // Initiate the connection status menu in unknown state by default.
            // TODO: Check status in case the the VPN is already running.
            appKitController._AppKitBridge_setConnectionStatus(.unknown)

            NotificationCenter.default.addObserver(forName: NSNotification.kVpnConnected,
                                                   object: nil,
                                                   queue: .main)
            { _ in
                appKitController._AppKitBridge_setConnectionStatus(.connected)
            }
            NotificationCenter.default.addObserver(forName: NSNotification.kVpnDisconnected,
                                                   object: nil,
                                                   queue: .main)
            { _ in
                appKitController._AppKitBridge_setConnectionStatus(.disconnected)
            }
        }
    }

    public func loadAppKitIntegrationFramework() -> NSObject {
        if let frameworksPath = Bundle.main.privateFrameworksPath {
            let bundlePath = "\(frameworksPath)/AppKitIntegration.framework"
            do {
                try Bundle(path: bundlePath)?.loadAndReturnError()

                let bundle = Bundle(path: bundlePath)!
                DDLogInfo("[CatalystApp] AppKit bundle loaded successfully")

                if let appKitControllerClass = bundle.classNamed("AppKitIntegration.AppKitController") as? NSObject.Type {
                    return appKitControllerClass.init()
                }
            } catch {
                DDLogInfo("[CatalystApp] Error loading: \(error)")
            }
        }
        preconditionFailure("[CatalystApp] Unable to load")
    }

#endif
