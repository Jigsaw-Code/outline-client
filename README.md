# Outline Client
[![Build Status](https://travis-ci.org/Jigsaw-Code/outline-client.svg?branch=master)](https://travis-ci.org/Jigsaw-Code/outline-client)

The Outline Client is a cross-platform VPN or proxy client for Windows, macOS, iOS, Android, and ChromeOS.  The Outline Client is designed for use with the [Outline Server](https://github.com/Jigsaw-Code/outline-server) software, but it is fully compatible with any [Shadowsocks](https://shadowsocks.org/) server.

The client's user interface is implemented in [Polymer](https://www.polymer-project.org/) 2.0.  Platform support is provided by [Cordova](https://cordova.apache.org/) and [Electron](https://electronjs.org/), with additional native components in this repository.

## Requirements for all builds

All builds require [yarn](https://yarnpkg.com/en/docs/install), in addition to other per-platform requirements. After cloning this repo install all dependencies with the command.

    yarn

## Building the web app

Outline clients share the same web app across all platforms. This code is located in the src/www directory. If you are making changes to the shared web app and do not need to test platform-specific functionality, you can test in a desktop browser by running:

    yarn gulp build --platform=browser
    yarn cordova run browser

The latter command will open a browser instance running the app. Browser platform development will use fake servers to test successful and unsuccessful connections.

UI components are located in [src/www/ui_components](src/www/ui_components). The app logic is located in [src/www/app](src/www/app).

*Tip: Build with `(export BUILD_ENV=development; yarn gulp build --platform=browser)` to enable source maps.*

## Building the Android app

Additional requirements for Android:

* Android Studio 4+
* Android SDK 29

To build for android, run:

    yarn gulp build --platform=android

To rebuild after modifying platform dependent files, run:

    yarn cordova platform rm android && yarn gulp build --platform=android

If this gives you unexpected Cordova errors, run:

    yarn run clean && yarn && yarn gulp build --platform=android

Cordova will generate a new Android project in the platforms/android directory.  Install the built apk by  platforms/android/build/outputs/apk/android-armv7-debug.apk

To learn more about developing for Android, see [docs/android-development](docs/android-development.md).

### Building for Android with Docker

A Docker image with all pre-requisites for Android builds is included.  To build:

* Install dependencies with `./tools/build/build.sh yarn`
* Then build with `./tools/build/build.sh yarn gulp build --platform=android`

## Apple (macOS and iOS)

Additional requirements for Apple:

* An Apple Developer Account.  You will need to be invited to join the "Jigsaw Operations LLC" team
* XCode 11+ ([download](https://developer.apple.com/xcode/))
* XCode command line tools

To build for macOS (OS X), run:

    yarn run clean && yarn && yarn gulp build --platform=osx

To build for iOS, run:

    yarn run clean && yarn && yarn gulp build --platform=ios

To learn more about developing for Apple, see [docs/apple-development](docs/apple-development.md)


## Electron

Unlike the Android and Apple clients, the Windows and Linux clients use the Electron framework, rather than Cordova.

### Development

To build the Electron clients, run:

    yarn do src/electron/build

To run the Electron clients, run:

    yarn do src/electron/run

To package the Electron clients into an installer executable, run:

    yarn do src/electron/package_[linux|windows]
 
#### VSCode

If using VSCode to develop, then insert the following into your `.vscode` folder

`launch.json`

    {
      "version": "0.2.0",
      "configurations": [
        {
          "name": "Debug Client",
          "type": "node",
          "request": "launch",
          "cwd": "${workspaceFolder}",
          "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
          "windows": {
            "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron.cmd"
          },
          "args" : ["."],
          "outputCapture": "std",
          "preLaunchTask": "Build Electron Client",
          "outFiles": ["${workspaceFolder}/www/**/*.js"]
        }
      ]
    }   

 `tasks.json`

    {
      "version": "2.0.0",
      "tasks": [
        {
          "label": "Build Electron Client",
          "type": "shell",
          "command": "yarn do src/electron/build",
          "windows": {
            "command": "yarn do src/electron/build"
          },
          "group": "build",
          "presentation": {
            "reveal": "always",
            "panel": "new"
          }
        }
      ]
    }

Then select the "

### Windows

Additional requirements for building on Windows:

* [Cygwin](https://cygwin.com/install.html). It provides the "missing Unix pieces" required by build system such as rsync (and many others).  It may be necessary to manually choose to install `rsync` in the Cygwin installer.

## Error reporting

To enable error reporting through [Sentry](https://sentry.io/) for local builds, run:
``` bash
export SENTRY_DSN=[Sentry development API key]
[platform-specific build command]
```

Release builds on CI are configured with a production Sentry API key.
