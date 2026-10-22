# Outline Client iOS Development Instructions

This document describes how to develop and debug the native side of the Outline Client for iOS. For the build commands, see the [Capacitor client README](../README.md).

## Getting Started

You will need:

- Node (see the root `.nvmrc`) and Go (see the root `go.mod`).
- An Apple Device and Developer Account.
- Xcode ([download](https://developer.apple.com/xcode/)) and its command line tools: `xcode-select --install`.

## Layout

- `App/`: the Xcode project of the app (`App.xcodeproj`, scheme `Outline`). It embeds the `VpnExtension` target from `OutlineLib` and links the plugin through the Swift package `App/CapApp-SPM`, which `cap sync ios` regenerates.
- `OutlineLib/`: the `VpnExtension` network extension (`PacketTunnelProvider`) and its unit tests (`VpnExtensionTest`).
- `OutlineAppleLib/`: the Swift package shared by the plugin and the extension: tunnel management (`OutlineTunnel`), error codes (`OutlineError`), Sentry logging (`OutlineSentryLogger`) and the VPN status notifications (`OutlineNotification`).
- The plugin itself is in `../plugins/capacitor-plugin-outline/ios`.
- Both the app and the extension link `Tun2socks.xcframework` from `output/client/apple/`, which `npm run action client/go/build ios` produces (`cap sync ios` runs it for you).

## Opening the Xcode Project

```sh
npm run action client/capacitor/web_build ios
cd client/capacitor
npx cap sync ios
npx cap open ios
```

Changes made in Xcode to the files under `App/`, `OutlineLib/` and `OutlineAppleLib/` are made in their version-controlled location; nothing needs to be copied back.

## Configure code signing

Apple is quite particular when it comes to making sure your app is properly signed, even in development.

1. In Xcode, make sure you are logged into your Apple Developer account and that your personal devices are registered to it. Go to **Settings > Accounts** and make sure your account is set.
1. Select the "Outline" target in the left navigation bar and go to the "Signing & Capabilities" tab.

### Internal Contributors

1. Ensure that the Outline Foundation team is selected for "Team".
1. Do the same for the "VpnExtension" target.

### External Contributors

For **release builds via the command line**, set the `DEVELOPMENT_TEAM` environment variable (the app target has no team of its own):

```sh
DEVELOPMENT_TEAM=<your_team_id> npm run action client/capacitor/build ios -- --buildMode=release --versionName=<version>
```

For **development in Xcode**:

1. Select the "Team" for your own account.
1. Change the bundle identifier (`org.outline.ios.client`) to something unique.
1. Remove the app group `group.org.getoutline.client`.
1. Do the same for the "VpnExtension" target.

## Running the App

### Specify the Run Destination

- Run on a simulator: helpful to test the UI, but the VPN doesn't work on simulators, so this option is not recommended for testing connections.
- **(Best)** Run on a physical iOS device: the best option to evaluate how the app performs on a real device. You will need to enable development mode on the device and register it in your developer account.

See [Devices and Simulator](https://developer.apple.com/documentation/xcode/devices-and-simulator) for details on running on a physical iOS device or the simulator.

### Build and Start the App

Either run from Xcode (**Product > Run**), or from the command line:

```sh
cd client/capacitor
npx cap run ios
```

> [!WARNING]
> If a build fails with `Command CodeSign failed with a nonzero exit code`, clean the build folder first (**Product > Clean Build Folder…**).

## Inspect Logs

The easiest way to inspect logs is to use the `log` command. To see the client app logs in real time, you can use `log stream` with a `--predicate` flag to select the messages sent by the Outline code:

```sh
log stream  --info --predicate 'senderImagePath contains "Outline.app"'
```

In the Console app, select the **Action > Include Info Messages** menu, and set the filter to "Library Path" "contains" "Outline.app".

> 💡 Tip: You can **save searches** in the macOS Console app.

For further debugging, you can include relevant messages from the Network Extension subsystem:

```sh
log stream  --info --predicate 'senderImagePath contains "Outline.app" or (processImagePath contains "Outline.app" and subsystem contains "com.apple.networkextension")'
```

To see past logs use `log show` and the `--last` flag.

Private values are redacted from Apple system logs by default. To include private debug values while developing, run:

```sh
sudo log config --mode "private_data:on"
```

Restore the default redaction behavior when you are done:

```sh
sudo log config --mode "private_data:off"
```

For details on Apple logging, see [Your Friend the System Log](https://developer.apple.com/forums/thread/705868/).

## Debug the VpnExtension

The VpnExtension runs in a separate process and its output is not logged to the Xcode console. To view its log statements see the "Inspect Logs" section.

Xcode doesn't automatically attach to the VpnExtension because it's started on demand by the system.

- If the VpnExtension is running:
  - In Xcode, select **Debug > Attach to Process > VpnExtension**
- If the VpnExtension is not running:
  - In Xcode, select **Debug > Attach to Process by PID or Name…**
  - Fill **PID or Process Name** with `VpnExtension` and press **Attach**

For more info, see [Debug, Profile, and Test Your App Extension](https://developer.apple.com/library/content/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html#//apple_ref/doc/uid/TP40014214-CH5-SW8).

### Unit tests

```sh
npm run action client/capacitor/test ios
```

runs the `VpnExtensionTest` scheme of `OutlineLib/OutlineLib.xcodeproj` on the iOS Simulator (building the tun2socks xcframework first).

### Debug `VpnStartFailure`

Sometimes the app will refuse to connect with a `VpnStartFailure` error. If that happens, it may be the case that the device is trying to use a stale version of the extension.

To fix, run:

```sh
pkill -9 VpnExtension
pluginkit -Amv | cut -f 4 | grep Outline | while IFS= read -r p; do pluginkit -r "$p"; done;
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -gc
```

This will kill any running VPN extension, unregister all versions of the Outline VPN plugin and garbage collect the Launch Services database.

#### Delete the existing VPN configuration

You may want to also delete the VPN configurations:

1. Open the Settings app
1. Go to *VPN*
1. Press the Info button for the Outline service
1. Press *Remove Configuration…* and confirm

#### Restart

If all fails, restart your device. That usually takes care of the issue.

## Debug the web UI

The web view of a debug build is inspectable from Safari's **Develop** menu (enable it under **Settings > Advanced > Show Develop menu in menu bar** first): select the device or simulator, then the Outline page. To reload the UI without re-running the application, reload it from the inspector.
