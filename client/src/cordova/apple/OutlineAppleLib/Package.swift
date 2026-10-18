// swift-tools-version: 5.6
// The swift-tools-version declares the minimum version of Swift required to build this package.

// Copyright 2024 The Outline Authors
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

import PackageDescription

let package = Package(
    name: "OutlineAppleLib",
    defaultLocalization: "en",
    platforms: [
        // CocoaLumberjack 3.8.0 dropped support for iOS < 11 and macOS < 10.13.
        // See https://github.com/CocoaLumberjack/CocoaLumberjack/releases/tag/3.8.0.
        // These cannot be upgraded without also upgrading the entire project.
       .iOS("15.5"),
       .macOS(.v12),
    ],
    products: [
        .library(
            // OutlineAppleLib is used by the Cordova plugin
            name: "OutlineAppleLib",
            targets: ["OutlineSentryLogger", "OutlineTunnel", "OutlineCatalystApp", "OutlineNotification", "OutlineError"]
        ),
        .library(
            // OutlineVPNExtensionLib is used by the VPN extension
            name: "OutlineVPNExtensionLib",
            targets: ["OutlineError"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/CocoaLumberjack/CocoaLumberjack.git", from: "3.8.5"),
        .package(url: "https://github.com/getsentry/sentry-cocoa", from: "8.26.0"),
    ],
    targets: [
        .target(
            name: "OutlineCatalystApp",
            dependencies: [
                .product(name: "CocoaLumberjackSwift", package: "CocoaLumberjack"),
                "OutlineNotification",
            ]
        ),
        .target(name: "OutlineError"),
        .target(name: "OutlineNotification"),
        .target(
            name: "OutlineSentryLogger",
            dependencies: [
                .product(name: "CocoaLumberjackSwift", package: "CocoaLumberjack"),
                .product(name: "Sentry", package: "sentry-cocoa"),
            ]
        ),
        .target(
            name: "OutlineTunnel",
            dependencies: [
                "OutlineError",
                .product(name: "CocoaLumberjackSwift", package: "CocoaLumberjack"),
            ]
        ),
    ]
)
