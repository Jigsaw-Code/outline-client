# <img alt="Outline Client Logo" src="../docs/resources/logo_client.png" title="Outline Client" width="32">&nbsp;&nbsp;Outline Client

This document provides a guide for AI and human agents working on the Outline Client.

## Directory Structure

The `/client` directory contains the source code for all Outline client applications. Here's a breakdown of the key subdirectories:

*   `/electron`: Contains the Electron-specific code for the desktop client, including the main process, preload scripts, and build configurations.
*   `/go`: Contains shared Go source code that is used across platforms for networking and other functionality that cannot be done on the browser.
*   `/capacitor`: Contains the Capacitor-based mobile client: the web shell (`src/`), the native plugin (`plugins/capacitor-plugin-outline`), and the native projects and libraries (`ios/`, `android/`).
*   `/web`: Contains the shared web-based UI components, built with TypeScript. This code is used by both the Electron and Capacitor applications.

## Key Technologies

*   **Electron**: Used to build the desktop client for Windows and Linux.
*   **Capacitor**: Used to build the clients for iOS and Android.
*   **[Lit](https://lit.dev/)**: The UI framework for all web components in the client.
*   **TypeScript**: Used for all web-based code.
*   **Go**: Used to implement the networking and other shared code.

## Building and Running the Client

The `npm run action` command is used to build and run the client applications.

### Shared Web App Development

If you are making changes to the shared web app and do not need to test platform-specific functionality, you can test in a desktop browser by running:

```sh
npm run action client/capacitor/start
```

The app logic is located in `web/app`. UI components are located in `web/ui_components`. To work on an individual UI element, use Storybook:

```sh
npm run storybook
```

### Electron Client

*   **Build (Linux)**: `npm run action client/electron/build linux -- --arch=[x64|arm64]`
*   **Build (Windows)**: `npm run action client/electron/build windows -- --arch=[ia32|arm64]`

### Capacitor Clients

*   **Build (Android)**: `npm run action client/capacitor/build android`
*   **Build (iOS)**: `npm run action client/capacitor/build ios`

### Configuration Flags

Certain actions take configuration flags. Since they are run through `npm`, you must use the `--` separator to pass them to the underlying process. For example:

```sh
SENTRY_DSN=<your sentry dsn> DEVELOPMENT_TEAM=<your apple team id> npm run action client/capacitor/build ios -- --buildMode=release --versionName=<your version name>
```

## Testing the Client

*   **Web Components**: `npm run action client/web/test`
*   **Go Backend**: `go test -race -bench=. -benchtime=100ms ./client/...`
*   **VpnExtension (iOS)**: `npm run action client/capacitor/test ios`

## Additional Resources

*   [Life of a Packet](/docs/life_of_a_packet.md): Learn how the Outline Client works.
*   [Developing with Capacitor (iOS and Android)](capacitor)
*   [Developing for iOS](capacitor/ios)
*   [Developing for Android](capacitor/android)
*   [Developing for Electron (Windows and Linux)](electron)
