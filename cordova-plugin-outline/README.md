# cordova-plugin-outline

This Cordova plugin provides the ability to start a system-wide VPN, connected to a local Shadowsocks client.

We use [tun2socks](https://github.com/ambrop72/badvpn-googlecode-export/blob/master/tun2socks/badvpn-tun2socks.8) as an adapter; it receives all of the device’s traffic through the VPN network interface (TUN) and forwards it to a local Shadowsocks server.

## shadowsocks-libev

### Android update instructions

The client code is https://github.com/shadowsocks/shadowsocks-libev, is compiled to a native shared library using the same process as https://github.com/shadowsocks/shadowsocks-android.

`libss-local.so` is built with the help of https://github.com/shadowsocks/shadowsocks-android.

It should be refreshed periodically; a script is included to do so, e.g.:
```bash
./update-shadowsocks-libev.sh 2.6.3
```

Upon successful completion, the script stages a commit including the new binary.

### Apple update instructions

We use a custom framework dependency, Shadowsocks, that implements shadowsocks-libev. To update it see `../third_party/shadowsocks-libev/apple/README.md`.

## tun2socks

### Android update instructions

```
ndk-build -C ../third_party/badvpn APP_BUILD_SCRIPT=Android.mk NDK_PROJECT_PATH=`pwd` NDK_APPLICATION_MK=`pwd`/../third_party/badvpn/Application.mk
cp libs/armeabi-v7a/libtun2socks.so android/libs/armeabi-v7a/libtun2socks.so
cp libs/x86/libtun2socks.so android/libs/x86/libtun2socks.so
```

For debug builds, which enable asserts and improved backtraces, append `NDK_DEBUG=1`.

### Apple update instructions

We use a custom framework dependency, PacketProcessor, that implements tun2socks. To update it see `../third_party/Potatso/README.md`

## Target Platforms

This plugin supports Android, iOS, and macOS.

### Android
This plugin targets Android devices running Lollipop (API 22), or higher.

### Apple
This plugin targets Apple devices running iOS 11.0+ and macOS/OS X 10.11.

## JavaScript API

```ts

// Represents a Shadowsocks server configuration.
interface ServerConfig {
  method?: string;
  password?: string;
  host?: string;
  port?: number;
  name?: string;
}

declare namespace cordova.plugins.outline {

  export var Log: {

    // Initializes the error reporting framework with the supplied credentials.
    initialize(apiKey: string): Promise<void>;

    // Sends previously captured logs and events to the error reporting framework.
    // Associates the report to the provided unique identifier.
    send(uuid: string): Promise<void>;
  }

  // Represents a VPN tunnel to a proxy through the plugin.
  export class Tunnel {

    // Creates a new instance with |serverConfig|.
    // A sequential ID will be generated if |id| is absent.
    constructor(serverConfig: ShadowsocksServerConfig, id?: string);

    // Starts the VPN service, and tunnels all the traffic to a local Shadowsocks
    // server as dictated by its configuration. If there is another running
    // instance, broadcasts a disconnect event and stops the active tunnel.
    // In such case, the VPN is not torn down.
    start(): Promise<void>;


    // Stops the tunnel and VPN service.
    stop(): Promise<void>;

    // Returns whether the tunnel instance is active.
    isRunning(): Promise<boolean>;

    // Sets a listener, to be called when the VPN tunnel status changes.
    onStatusChange(listener: (status: TunnelStatus) => void): void;
  }
}

```

## Android Code Sources

We have used as a starting point open source code from [Psiphon](https://psiphon.ca/uz@Latn/open-source.html), specifically their fork of badvpn.

* `../third_party/badvpn`:
  * built upon Psiphon's fork of [badvpn](https://github.com/ambrop72/badvpn).
  * starting point: https://github.com/mei3am/ps/tree/master/Android/badvpn
  * Outline-specific changes mostly confined to tun2socks/tun2socks.c and marked with `// ==== OUTLINE ====` (like Psiphon-specific changes)

## Additional Apple Dependencies

We use the [Carthage dependency manager](https://github.com/Carthage/Carthage) to fetch Sentry Cocoa, CocoaLumberjack, and CocoaAsyncSocket.

To upgrade the Carthage dependencies:
* Install Carthage by running `brew install carthage`.
* Update the framework's version in Cartfile (e.g. `github "getsentry/sentry-cocoa" "x.y.z"`).
* Run `carthage update`. This will fetch the frameworks for macOS and iOS.
* Copy the frameworks to the `cordova-plugin-outline/apple/lib` (e.g. `cp -R Carthage/Build/iOS/Sentry.framework cordova-plugin-outline/apple/lib/Sentry/ios/`)
* Add Cartfile and Cartfile.resolved to git and commit the changes.

