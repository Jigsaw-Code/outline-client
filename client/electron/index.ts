// Copyright 2020 The Outline Authors
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

// Directly import @sentry/electron main process code.
// See: https://docs.sentry.io/platforms/javascript/guides/electron/#webpack-configuration
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import * as url from 'url';

import * as net from '@outline/infrastructure/net';
import * as Sentry from '@sentry/electron/main';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  shell,
  Tray,
} from 'electron';
import {autoUpdater} from 'electron-updater';

import {lookupIp} from './connectivity';
import {invokeGoMethod} from './go_plugin';
import {GoVpnTunnel} from './go_vpn_tunnel';
import {installRoutingServices, RoutingDaemon} from './routing_service';
import {TunnelStore} from './tunnel_store';
import {closeVpn, establishVpn, onVpnStateChanged} from './vpn_service';
import {VpnTunnel} from './vpn_tunnel';
import {
  StartRequestJson,
  TunnelStatus,
} from '../web/app/outline_server_repository/vpn';
import * as errors from '../web/model/errors';

// TODO: can we define these macros in other .d.ts files with default values?
// Build-time macros injected by webpack's DefinePlugin:
//   - SENTRY_DSN is either undefined or a url string
//   - APP_VERSION should always be a string
declare const SENTRY_DSN: string | undefined;
declare const APP_VERSION: string;

// Run-time environment variables:
const debugMode = process.env.OUTLINE_DEBUG === 'true';

const IS_LINUX = os.platform() === 'linux';
const IS_WINDOWS = os.platform() === 'win32';

if (IS_LINUX) {
  // GPU rendering freezes the UI on some Linux systems (buttons never paint on
  // the first-run screen): https://github.com/OutlineFoundation/outline-apps/issues/2794
  // Must be set before the app's "ready" event.
  app.commandLine.appendSwitch('disable-gpu');
}

// Used for the auto-connect feature. There will be a tunnel in store
// if the user was connected at shutdown.
const autoConnectTunnelStore = new TunnelStore(app.getPath('userData'));
const configuredTunnelStore = new TunnelStore(
  app.getPath('userData'),
  'configured_connection_store'
);

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: Electron.BrowserWindow | null;
let tray: Tray;

let isAppQuitting = false;
let trayStatus = TunnelStatus.DISCONNECTED;
// Default to English strings in case we fail to retrieve them from the renderer process.
let localizedStrings: {[key: string]: string} = {
  'tray-open-window': 'Open',
  'connect-button-label': 'Connect',
  'disconnect-button-label': 'Disconnect',
  quit: 'Quit',
};

const TRAY_ICON_IMAGES = {
  connected: createTrayIconImage('connected.png'),
  disconnected: createTrayIconImage('disconnected.png'),
};

const enum Options {
  AUTOSTART = '--autostart',
}

let currentTunnel: VpnTunnel | undefined;

/**
 * Sentry must be initialized before electron app is ready:
 *   - https://github.com/getsentry/sentry-electron/blob/3.0.7/src/main/ipc.ts#L70
 */
function setupSentry(): void {
  // Use 'typeof(v)' instead of '!!v' here to prevent ReferenceError
  if (typeof SENTRY_DSN !== 'undefined' && typeof APP_VERSION !== 'undefined') {
    // This config makes console (log/info/warn/error - no debug!) output go to breadcrumbs.
    Sentry.init({
      dsn: SENTRY_DSN,
      release: APP_VERSION,
      maxBreadcrumbs: 100,
      debug: debugMode,
    });
  }
}

function setupMenu(): void {
  if (debugMode) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Developer',
          submenu: Menu.buildFromTemplate([
            {role: 'reload'},
            {role: 'forceReload'},
            {role: 'toggleDevTools'},
          ]),
        },
      ])
    );
  } else {
    // Hide standard menu.
    Menu.setApplicationMenu(null);
  }
}

function setupTray(): void {
  tray = new Tray(TRAY_ICON_IMAGES.disconnected);
  // On Linux, the click event is never fired: https://github.com/electron/electron/issues/14941
  tray.on('click', () => {
    openApplication();
  });
  tray.setToolTip('Outline');
  setTrayStatus(TunnelStatus.DISCONNECTED);
}

function setupWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 432,
    height: 768,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Icon is not shown in Ubuntu Dock. It is a recurrent issue happened in Linux:
  //   - https://github.com/electron-userland/electron-builder/issues/2269
  // A workaround is to forcibly set the icon of the main window.
  //
  // This is a workaround because the icon is fixed to 64x64, which might look blurry
  // on higher dpi (>= 200%) settings. Setting it to a higher resolution icon (e.g., 128x128)
  // does not work either because Ubuntu's image resize algorithm is pretty bad, the icon
  // looks too sharp in a regular dpi (100%) setting.
  //
  // The ideal solution would be: either electron-builder supports the app icon; or we add
  // dpi-aware features to this app.
  if (IS_LINUX) {
    mainWindow.setIcon(
      path.join(
        app.getAppPath(),
        'client',
        'electron',
        'icons',
        'png',
        '64x64.png'
      )
    );
  }

  const pathToIndexHtml = path.join(
    app.getAppPath(),
    'client',
    'www',
    'index_electron.html'
  );
  const webAppUrl = new url.URL(`file://${pathToIndexHtml}`);

  // Debug mode, etc.
  const queryParams = new url.URLSearchParams();
  if (debugMode) {
    queryParams.set('debug', 'true');
  }
  queryParams.set('appName', app.getName());
  webAppUrl.search = queryParams.toString();

  const webAppUrlAsString = webAppUrl.toString();

  console.info(`loading web app from ${webAppUrlAsString}`);
  mainWindow.loadURL(webAppUrlAsString);

  mainWindow.on('close', (event: Event) => {
    if (isAppQuitting) {
      // Actually close the window if we are quitting.
      return;
    }
    // Hide instead of close so we don't need to create a new one.
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    // Clear the reference so callers can detect that the window is gone.
    mainWindow = null;
  });
  if (os.platform() === 'win32') {
    // On Windows we hide the app from the taskbar.
    mainWindow.on('minimize', (event: Event) => {
      event.preventDefault();
      mainWindow.hide();
    });
  }

  // TODO: is this the most appropriate event?
  mainWindow.webContents.on('did-finish-load', () => {
    // TODO: refactor channel name and namespace to a constant
    mainWindow.webContents.send(
      'outline-ipc-localization-request',
      Object.keys(localizedStrings)
    );
    interceptShadowsocksLink(process.argv);
  });

  // The client is a single page app - loading any other page means the
  // user clicked on one of the Privacy, Terms, etc., links. These should
  // open in the user's browser.
  mainWindow.webContents.on(
    'will-navigate',
    (event: Electron.Event, url: string) => {
      try {
        const parsed: URL = new URL(url);
        if (parsed.protocol === 'https:') {
          shell.openExternal(url);
        } else {
          console.warn(
            `Refusing to open URL with protocol "${parsed.protocol}"`
          );
        }
      } catch (e) {
        console.warn(`Could not parse URL ${url}:`, e);
      }
      event.preventDefault();
    }
  );
}

function isTrayConnected(status = trayStatus) {
  return status !== TunnelStatus.DISCONNECTED;
}

function getTrayConnectDisconnectLabel(status = trayStatus) {
  return isTrayConnected(status)
    ? localizedStrings['disconnect-button-label']
    : localizedStrings['connect-button-label'];
}

function setTrayStatus(status: TunnelStatus) {
  trayStatus = status;
  const isConnected = isTrayConnected(status);
  tray.setImage(
    isConnected ? TRAY_ICON_IMAGES.connected : TRAY_ICON_IMAGES.disconnected
  );

  const menuTemplate: MenuItemConstructorOptions[] = [
    {
      label: localizedStrings['tray-open-window'],
      click: openApplication,
    },
    {type: 'separator'},
    {
      label: getTrayConnectDisconnectLabel(status),
      click: menuItem => void toggleTrayVpnConnection(menuItem.label),
    },
    {type: 'separator'},
    {label: localizedStrings['quit'], click: quitApp},
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

function createTrayIconImage(imageName: string) {
  const image = nativeImage.createFromPath(
    path.join(app.getAppPath(), 'client', 'resources', 'tray', imageName)
  );
  if (image.isEmpty()) {
    throw new Error(`cannot find ${imageName} tray icon image`);
  }
  return image;
}

// Signals that the app is quitting and quits the app. This is necessary because we override the
// window 'close' event to support minimizing to the system tray.
async function quitApp() {
  isAppQuitting = true;
  await stopVpn();
  app.quit();
}

function openApplication() {
  mainWindow?.show();
}

function interceptShadowsocksLink(argv: string[]) {
  if (argv.length > 1) {
    const protocols = ['ss://', 'ssconf://'];
    let url = argv[1];
    for (const protocol of protocols) {
      if (url.startsWith(protocol)) {
        if (mainWindow) {
          // The system adds a trailing slash to the intercepted URL (before the fragment).
          // Remove it before sending to the UI.
          url = `${protocol}${url
            .substring(protocol.length)
            .replace(/\/$/g, '')}`;
          // TODO: refactor channel name and namespace to a constant
          mainWindow.webContents.send('outline-ipc-add-server', url);
        } else {
          console.error('called with URL but mainWindow not open');
        }
      }
    }
  }
}

// Set the app to launch at startup to connect automatically in case of a shutdown while
// proxying.
async function setupAutoLaunch(request: StartRequestJson): Promise<void> {
  try {
    await autoConnectTunnelStore.save(request);
    if (IS_WINDOWS) {
      app.setLoginItemSettings({openAtLogin: true, args: [Options.AUTOSTART]});
    }
    // TODO(linux): support auto-launch on Debian. First check whether the Go
    // backend service already restores the tunnel on reboot — if so, no
    // Electron-side auto-launch hook is needed.
  } catch (e) {
    console.error(`Failed to set up auto-launch: ${e.message}`);
  }
}

async function tearDownAutoLaunch() {
  try {
    if (IS_WINDOWS) {
      app.setLoginItemSettings({openAtLogin: false});
    }
    await autoConnectTunnelStore.clear();
  } catch (e) {
    console.error(`Failed to tear down auto-launch: ${e.message}`);
  }
}

async function saveConfiguredTunnel(request: StartRequestJson): Promise<void> {
  try {
    await configuredTunnelStore.save(request);
  } catch (e) {
    console.error(`failed to save configured tunnel: ${e.message}`);
  }
}

async function loadConfiguredTunnel(): Promise<StartRequestJson | undefined> {
  try {
    return await configuredTunnelStore.load();
  } catch (e) {
    console.warn('could not load configured tunnel:', e);
    return undefined;
  }
}

async function toggleTrayVpnConnection(menuItemLabel: string) {
  console.log('toggling tray vpn connection');
  const isConnectAction =
    menuItemLabel === localizedStrings['connect-button-label'];

  if (!isConnectAction) {
    await stopVpn();
    return;
  }

  const request = await loadConfiguredTunnel();
  if (!request) {
    openApplication();
    return;
  }

  console.log(`connecting to ${request.name} (${request.id}) from tray...`);
  try {
    await startVpn(request, false);
    console.log(`connected to ${request.name} (${request.id})`);
    await setupAutoLaunch(request);
    await saveConfiguredTunnel(request);
  } catch (e) {
    console.error('could not connect from tray:', e);
    void stopVpn();
    openApplication();
  }
}

// Factory function to create a VPNTunnel instance backed by a network stack
// specified at build time.
async function createVpnTunnel(
  request: StartRequestJson,
  isAutoConnect: boolean
): Promise<VpnTunnel> {
  // We must convert the host from a potential "hostname" to an "IP" address
  // because startVpn will add a routing table entry that prefixed with this
  // host (e.g. "<host>/32"), therefore <host> must be an IP address.
  // TODO: make sure we resolve it in the native code
  const {host} = net.splitHostPort(request.firstHop);
  if (!host) {
    throw new errors.IllegalServerConfiguration('host is missing');
  }
  const hostIp = await lookupIp(host);
  const routing = new RoutingDaemon(hostIp || '', isAutoConnect);
  const tunnel = new GoVpnTunnel(routing, request.id, request.client);
  routing.onNetworkChange = tunnel.networkChanged.bind(tunnel);
  return tunnel;
}

// Invoked by both the start-proxying event handler and auto-connect.
async function startVpn(request: StartRequestJson, isAutoConnect: boolean) {
  console.debug('startVpn called with request ', JSON.stringify(request));

  if (IS_LINUX) {
    await establishVpn(request);
    return;
  }

  if (currentTunnel) {
    throw new Error('already connected');
  }

  currentTunnel = await createVpnTunnel(request, isAutoConnect);
  if (debugMode) {
    currentTunnel.enableDebugMode();
  }

  currentTunnel.onceDisconnected
    .then(() => {
      console.log(`disconnected from ${request.id}`);
      currentTunnel = undefined;
      setUiTunnelStatus(TunnelStatus.DISCONNECTED, request.id);
    })
    .catch(e => {
      console.error(`failed to disconnect from ${request.id}:`, e);
      throw e;
    });

  currentTunnel.onReconnecting(() => {
    console.log(`reconnecting to ${request.id}`);
    setUiTunnelStatus(TunnelStatus.RECONNECTING, request.id);
  });

  currentTunnel.onReconnected(() => {
    console.log(`reconnected to ${request.id}`);
    setUiTunnelStatus(TunnelStatus.CONNECTED, request.id);
  });

  // Don't check connectivity on boot: if the key was revoked or network connectivity is not ready,
  // we want the system to stay "connected" so that traffic doesn't leak.
  await currentTunnel.connect(!isAutoConnect);
  setUiTunnelStatus(TunnelStatus.CONNECTED, request.id);
}

// Invoked by both the stop-proxying event and quit handler.
async function stopVpn() {
  if (IS_LINUX) {
    await Promise.all([closeVpn(), tearDownAutoLaunch()]);
    return;
  }

  if (!currentTunnel) {
    return;
  }

  const onceDisconnected = currentTunnel.onceDisconnected;
  void currentTunnel.disconnect();
  await tearDownAutoLaunch();
  await onceDisconnected;
}

function setUiTunnelStatus(status: TunnelStatus, tunnelId: string) {
  // TODO: refactor channel name and namespace to a constant
  const event = 'outline-ipc-proxy-status';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, tunnelId, status);
  } else {
    console.warn(`received ${event} event but no mainWindow to notify`);
  }
  setTrayStatus(status);
}

function checkForUpdates() {
  autoUpdater.checkForUpdates().catch(e => {
    console.error('Failed to check for updates', e);
  });
}

function main() {
  setupSentry();

  if (!app.requestSingleInstanceLock()) {
    console.log('another instance is running - exiting');
    app.quit();
  }

  app.setAsDefaultProtocolClient('ss');
  app.setAsDefaultProtocolClient('ssconf');

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.on('ready', async () => {
    // To clearly identify app restarts in Sentry.
    console.info('Outline is starting');

    setupMenu();
    setupTray();
    // TODO(fortuna): Start the app with the window hidden on auto-start?
    setupWindow();

    if (IS_LINUX) {
      await onVpnStateChanged(setUiTunnelStatus);
    }

    let requestAtShutdown: StartRequestJson | undefined;
    try {
      requestAtShutdown = await autoConnectTunnelStore.load();
    } catch (e) {
      // No tunnel at shutdown, or failure - either way, no need to start.
      // TODO: Instead of quitting, how about creating the system tray icon?
      console.warn('Could not load active tunnel: ', e);
      await autoConnectTunnelStore.clear();
    }
    if (requestAtShutdown) {
      console.info(
        `was connected at shutdown, reconnecting to ${requestAtShutdown.id}`
      );
      setUiTunnelStatus(TunnelStatus.RECONNECTING, requestAtShutdown.id);
      try {
        await startVpn(requestAtShutdown, true);
        console.log(`reconnected to ${requestAtShutdown.id}`);
        await saveConfiguredTunnel(requestAtShutdown);
      } catch (e) {
        console.error(`could not reconnect: ${e.name} (${e.message})`);
      }
    }

    if (!debugMode) {
      checkForUpdates();
      // Check every six hours
      setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
    }
  });

  app.on('second-instance', (event: Event, argv: string[]) => {
    interceptShadowsocksLink(argv);
    // Someone tried to run a second instance, we should focus our window.
    openApplication();
  });

  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    openApplication();
  });

  // This event fires whenever the app's window receives focus.
  app.on('browser-window-focus', () => {
    // TODO: refactor channel name and namespace to a constant
    mainWindow?.webContents.send('outline-ipc-push-clipboard');
  });

  // This IPC handler allows the renderer process to call functions exposed by the backend.
  // It takes two arguments:
  //   - method: The name of the method to call.
  //   - params: A string representing the input data to the function.
  //
  // The handler returns the output string from the Go function if successful.
  // Both the input string and output string need to be interpreted by the renderer process according
  // to the specific API being called.
  // If the function encounters an error, it throws an Error that can be parsed by the `PlatformError`.
  ipcMain.handle(
    'outline-ipc-invoke-method',
    async (_, method: string, params: string): Promise<string> => {
      // TODO(fortuna): move all other IPCs here.
      switch (method) {
        case 'StartProxying': {
          // Connects to a proxy server specified by a config.
          //
          // If any issues occur, an Error will be thrown, which you can try-catch around
          // `ipcRenderer.invoke`. But you should avoid depending on the specific error type.
          // Instead, you should use its message property (which would probably be a JSON representation
          // of a PlatformError). See https://github.com/electron/electron/issues/24427.
          //
          // TODO: refactor channel name and namespace to a constant
          const request = JSON.parse(params) as StartRequestJson;
          // TODO: Rather than first disconnecting, implement a more efficient switchover (as well as
          //       being faster, this would help prevent traffic leaks - the Cordova clients already do
          //       this).
          if (currentTunnel) {
            console.log('disconnecting from current server...');
            void currentTunnel.disconnect();
            await currentTunnel.onceDisconnected;
          }

          console.log(`connecting to ${request.name} (${request.id})...`);

          try {
            await startVpn(request, false);
            console.log(`connected to ${request.name} (${request.id})`);
            await setupAutoLaunch(request);
            await saveConfiguredTunnel(request);
          } catch (e) {
            console.error('could not connect:', e);
            // clean up the state, no need to await because stopVpn might throw another error which can be ignored
            void stopVpn();
            throw e;
          }
          break;
        }

        case 'StopProxying':
          // Disconnects from the current server, if any.
          // TODO: refactor channel name and namespace to a constant
          await stopVpn();
          return '';

        default:
          return await invokeGoMethod(method, params);
      }
    }
  );

  // Install backend services and return the error code
  // TODO: refactor channel name and namespace to a constant
  ipcMain.handle('outline-ipc-install-outline-services', async () => {
    // catch custom errors (even simple as numbers) does not work for ipcRenderer:
    // https://github.com/electron/electron/issues/24427
    try {
      await installRoutingServices();
      return errors.ErrorCode.NO_ERROR;
    } catch (e) {
      if (typeof e === 'number') {
        return e;
      }
      return errors.ErrorCode.UNEXPECTED;
    }
  });

  // TODO: refactor channel name and namespace to a constant
  ipcMain.on('outline-ipc-quit-app', quitApp);

  // TODO: refactor channel name and namespace to a constant
  ipcMain.on(
    'outline-ipc-localization-response',
    (_, localizationResult: {[key: string]: string}) => {
      if (localizationResult) {
        localizedStrings = localizationResult;
      }
      setTrayStatus(trayStatus);
    }
  );

  // Notify the UI of updates.
  autoUpdater.on('update-downloaded', () => {
    // TODO: refactor channel name and namespace to a constant
    mainWindow?.webContents.send('outline-ipc-update-downloaded');
  });
}

main();
