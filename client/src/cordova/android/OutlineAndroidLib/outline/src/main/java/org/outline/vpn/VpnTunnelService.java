// Copyright 2018 The Outline Authors
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

package org.outline.vpn;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.NetworkRequest;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Objects;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.json.JSONException;
import org.json.JSONObject;
import org.outline.IVpnTunnelService;
import org.outline.TunnelConfig;
import org.outline.DetailedJsonError;
import org.outline.log.SentryErrorReporter;

import outline.ClientParser;
import outline.NewClientResult;
import platerrors.Platerrors;
import platerrors.PlatformError;
import tun2socks.ConnectRemoteDeviceResult;
import tun2socks.RemoteDevice;
import tun2socks.Tun2socks;

/**
 * Android service responsible for managing a VPN tunnel. Clients must bind to this
 * service in order to access its APIs.
 */
public class VpnTunnelService extends VpnService {
  private static final Logger LOG = Logger.getLogger(VpnTunnelService.class.getName());
  private static final int NOTIFICATION_SERVICE_ID = 1;
  private static final int NOTIFICATION_COLOR = 0x00BFA5;
  private static final String NOTIFICATION_CHANNEL_ID = "outline-vpn";
  private static final String TUNNEL_ID_KEY = "id";
  private static final String TUNNEL_CONFIG_KEY = "config";
  private static final String TUNNEL_SERVER_NAME = "serverName";

  public static final String STATUS_BROADCAST_KEY = "onStatusChange";
  public static final String START_LAST_TUNNEL_EXTRA = "startLastTunnel";
  public static final String STOP_ACTIVE_TUNNEL_EXTRA = "stopActiveTunnel";

  public enum TunnelStatus {
    INVALID(-1), // Internal use only.
    CONNECTED(0),
    DISCONNECTED(1),
    RECONNECTING(2);

    public final int value;
    TunnelStatus(int value) {
      this.value = value;
    }
  }

  // IPC message and intent parameters.
  public enum MessageData {
    TUNNEL_ID("tunnelId"),
    PAYLOAD("payload"),
    ERROR_REPORTING_API_KEY("errorReportingApiKey");

    public final String value;
    MessageData(final String value) {
      this.value = value;
    }
  }

  /** File descriptor for the local TUN device, provided by VpnService.Builder.establish(). */
  private ParcelFileDescriptor tunFd;
  /** The Go "remote device" implementation. */
  private RemoteDevice remoteDevice;

  private TunnelConfig tunnelConfig;
  private NetworkConnectivityMonitor networkConnectivityMonitor;
  private VpnTunnelStore tunnelStore;
  private Notification.Builder notificationBuilder;

  private final IVpnTunnelService.Stub binder = new IVpnTunnelService.Stub() {
    @Override
    public DetailedJsonError startTunnel(@NonNull TunnelConfig config) {
      return VpnTunnelService.this.startTunnel(config);
    }

    @Override
    public DetailedJsonError stopTunnel(String tunnelId) {
      return VpnTunnelService.this.stopTunnel(tunnelId);
    }

    @Override
    public boolean isTunnelActive(String tunnelId) {
      return VpnTunnelService.this.isTunnelActive(tunnelId);
    }

    @Override
    public void initErrorReporting(String apiKey) {
      VpnTunnelService.this.initErrorReporting(apiKey);
    }
  };

  @Override
  public void onCreate() {
    LOG.info("Creating VPN service.");
    networkConnectivityMonitor = new NetworkConnectivityMonitor();
    tunnelStore = new VpnTunnelStore(VpnTunnelService.this);
  }

  @Override
  public IBinder onBind(Intent intent) {
    LOG.info(String.format(Locale.ROOT, "Binding VPN service: %s", intent));
    String action = intent.getAction();
    if (action != null && action.equals(SERVICE_INTERFACE)) {
      return super.onBind(intent);
    }
    if (intent.getBooleanExtra(VpnServiceStarter.AUTOSTART_EXTRA, false)) {
      startLastSuccessfulTunnel();
    }
    String errorReportingApiKey =
        intent.getStringExtra(MessageData.ERROR_REPORTING_API_KEY.value);
    if (errorReportingApiKey != null) {
      initErrorReporting(errorReportingApiKey);
    }
    return binder;
  }

  /** This is the entrypoint when started by the OS. */
  @Override
  public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
    LOG.info(String.format(Locale.ROOT, "Starting VPN service: %s", intent));
    int superOnStartReturnValue = super.onStartCommand(intent, flags, startId);
    if (intent != null) {
      if (intent.getBooleanExtra(STOP_ACTIVE_TUNNEL_EXTRA, false)) {
        broadcastVpnConnectivityChange(TunnelStatus.DISCONNECTED);
        tearDownActiveTunnel();
        stopSelf();
        return START_NOT_STICKY;
      }
      if (intent.getBooleanExtra(START_LAST_TUNNEL_EXTRA, false)) {
        startLastSuccessfulTunnel();
        QuickSettingsTileService.requestTileUpdate(this);
        return superOnStartReturnValue;
      }
      // VpnServiceStarter puts AUTOSTART_EXTRA in the intent when the service starts automatically.
      boolean startedByVpnStarter =
          intent.getBooleanExtra(VpnServiceStarter.AUTOSTART_EXTRA, false);
      boolean startedByAlwaysOn = VpnService.SERVICE_INTERFACE.equals(intent.getAction());
      if (startedByVpnStarter || startedByAlwaysOn) {
        startLastSuccessfulTunnel();
      }
    }
    return superOnStartReturnValue;
  }

  @Override
  public void onRevoke() {
    LOG.info("VPN revoked.");
    broadcastVpnConnectivityChange(TunnelStatus.DISCONNECTED);
    tearDownActiveTunnel();
  }

  @Override
  public void onDestroy() {
    LOG.info("Destroying VPN service.");
    broadcastVpnConnectivityChange(TunnelStatus.DISCONNECTED);
    tearDownActiveTunnel();
  }

  // Tunnel API

  /**  This is the entry point when called from the Outline plugin, via the service IPC. */
  private DetailedJsonError startTunnel(@NonNull final TunnelConfig config) {
    return Errors.toDetailedJsonError(startTunnel(config, false));
  }

  /** Shared logic between the manual and automated entry points. */
  @Nullable
  private synchronized PlatformError startTunnel(
          @NonNull final TunnelConfig config, boolean isAutoStart) {
    LOG.info(String.format(Locale.ROOT, "Starting tunnel %s for server %s", config.id, config.name));
    if (config.id == null || config.transportConfig == null) {
      return new PlatformError(Platerrors.InvalidConfig, "id and transportConfig are required");
    }
    // We check if the VPN is already running. This happens when a user connects to a server while
    // already connected to another one.
    // Instead of tearing down the VPN and starting from scratch, we just replace the remote device
    // and restart the traffic exchange.
    final boolean alreadyRunning = this.tunnelConfig != null && this.tunFd != null;
    if (alreadyRunning) {
      // Broadcast the previous instance disconnect event before reassigning the tunnel config.
      broadcastVpnConnectivityChange(TunnelStatus.DISCONNECTED);
      stopForeground();
      try {
        // Stops the remote device; does not tear down the VPN to avoid leaking traffic.
        this.stopRemoteDevice();
      } catch (Exception e) {
        LOG.log(Level.SEVERE, "Failed to disconnect tunnel", e);
      }
    } else {
      // Make sure we have a fully clean state.
      this.tunnelConfig = null;
      this.tunFd = null;
    }

    final ClientParser clientConfig = new ClientParser();
    clientConfig.setDataDir(this.getFilesDir().getAbsolutePath());
    final NewClientResult clientResult = clientConfig.newClient(config.id, config.transportConfig);
    if (clientResult.getError() != null) {
      LOG.log(Level.WARNING, "Failed to create Outline Client", clientResult.getError());
      tearDownActiveTunnel();
      return clientResult.getError();
    }
    final outline.Client client = clientResult.getClient();
    this.tunnelConfig = config;

    // If the VPN is already running, we skip the set up of the VPN routing.
    // TODO(fortuna): we should probably shutdown and restart, in case the config changed.
    if (!alreadyRunning) {
      // Only establish the VPN if this is not a tunnel restart.
      try {
        // A "fake" local DNS resolver. Outline will intercept the real resolver at this address.
        // Must align with: client/go/outline/configregistry/outline_dns.go
        String dnsResolver = "169.254.113.53";
        VpnService.Builder builder =
                new VpnService.Builder()
                        .setSession(this.getApplicationName())
                        // Standard MTU.
                        // TODO(fortuna): consider deriving it from the underlying MTU and selected transport.
                        .setMtu(1500)
                        // Some random local IP we believe won't conflict.
                        // TODO(fortuna): dynamically select it.
                        .addAddress("10.111.222.1", 24)
                        .addDnsServer(dnsResolver)
                        .setBlocking(true)
                        .addDisallowedApplication(this.getPackageName());

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          builder.setMetered(false);
        }
        // In absence of an API to remove routes, instead of adding the default route (0.0.0.0/0),
        // retrieve the list of subnets that excludes those reserved for special use.
        final ArrayList<Subnet> reservedBypassSubnets = getReservedBypassSubnets();
        for (Subnet subnet : reservedBypassSubnets) {
          builder.addRoute(subnet.address, subnet.prefix);
        }
        builder.addRoute(dnsResolver, 32);
        this.tunFd = builder.establish();
      } catch (Exception e) {
        LOG.log(Level.SEVERE, "Failed to establish the VPN", e);
      }

      if (this.tunFd == null) {
        LOG.severe("Failed to establish the VPN");
        tearDownActiveTunnel();
        return new PlatformError(Platerrors.SetupSystemVPNFailed, "failed to establish the VPN");
      }
    }

    final ConnectRemoteDeviceResult result = Tun2socks.connectRemoteDevice(client);
    if (result.getError() != null) {
      tearDownActiveTunnel();
      return result.getError();
    }
    this.remoteDevice = result.getDevice();
    LOG.info("Remote device created successfully.");

    if (!isAutoStart) {
      final PlatformError healthErr = this.remoteDevice.getHealthStatus();
      if (healthErr != null) {
        LOG.log(Level.SEVERE, "Remote device is not healthy", healthErr);
        tearDownActiveTunnel();
        return healthErr;
      }
      LOG.info("Remote device is healthy.");
    } else {
      LOG.info("Auto-start VPN, skip health check.");
    }

    final PlatformError err = Tun2socks.goRelayTraffic(this.tunFd.getFd(), this.remoteDevice);
    if (err != null) {
      LOG.log(Level.SEVERE, "Failed to relay traffic between TUN and remote devices", err);
      tearDownActiveTunnel();
      return err;
    }
    LOG.info("Relaying traffic between TUN device and remote device.");

    startNetworkConnectivityMonitor();
    startForegroundWithNotification(config.name);
    storeActiveTunnel(config);
    return null;
  }

  @Nullable
  private synchronized DetailedJsonError stopTunnel(@NonNull final String tunnelId) {
    if (!isTunnelActive(tunnelId)) {
      return Errors.toDetailedJsonError(new PlatformError(
          Platerrors.InternalError,
          "VPN profile is not active"));
    }
    broadcastVpnConnectivityChange(TunnelStatus.DISCONNECTED);
    tearDownActiveTunnel();
    return null;
  }

  private synchronized boolean isTunnelActive(final String tunnelId) {
    if (tunnelConfig == null || tunnelConfig.id == null) {
      return false;
    }
    return tunnelConfig.id.equals(tunnelId);
  }

  /** Helper method to tear down an active tunnel. */
  private void tearDownActiveTunnel() {
    // Stop monitoring network changes.
    try {
      final ConnectivityManager connectivityManager =
              (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
      connectivityManager.unregisterNetworkCallback(networkConnectivityMonitor);
    } catch (Exception e) {
      // Ignore, monitor not installed if the connectivity checks failed.
    }

    // Restore routing.
    if (this.tunFd != null) {
      try {
        // On close, the OS restores the routing and destroys the TUN device.
        this.tunFd.close();
      } catch (IOException e) {
        LOG.severe("Failed to close the VPN interface file descriptor.");
      } finally {
        this.tunFd = null;
      }
    }

    // Stop traffic exchange with remote after closing the TUN device, so the relay unblocks
    // promptly and Android can tear down the VPN network.
    this.stopRemoteDevice();

    // Clear VPN notification.
    stopForeground();

    // Save state indicating it's disconnected.
    this.tunnelStore.setTunnelStatus(TunnelStatus.DISCONNECTED);
    QuickSettingsTileService.requestTileUpdate(this);

    // Clear config that is no longer needed.
    this.tunnelConfig = null;
  }

  /** Stops the traffic exchange with the remote device. */
  private synchronized void stopRemoteDevice() {
    if (this.remoteDevice == null) {
      return;
    }
    final PlatformError err = this.remoteDevice.close();
    if (err != null) {
      LOG.log(Level.WARNING, "Failed to close remote device", err);
    } else {
      LOG.info("Remote device closed successfully.");
    }
    this.remoteDevice = null;
  }

  // Connectivity

  private class NetworkConnectivityMonitor extends ConnectivityManager.NetworkCallback {
    private final ConnectivityManager connectivityManager;

    public NetworkConnectivityMonitor() {
      this.connectivityManager =
          (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    @Override
    public void onAvailable(@NonNull Network network) {
      NetworkInfo networkInfo = connectivityManager.getNetworkInfo(network);
      LOG.fine(String.format(Locale.ROOT, "Network available: %s", networkInfo));
      if (networkInfo == null || networkInfo.getState() != NetworkInfo.State.CONNECTED) {
        return;
      }
      broadcastVpnConnectivityChange(TunnelStatus.CONNECTED);
      updateNotification(TunnelStatus.CONNECTED);

      if (VpnTunnelService.this.remoteDevice != null) {
        VpnTunnelService.this.remoteDevice.notifyNetworkChanged();
      }
    }

    @Override
    public void onLost(@NonNull Network network) {
      LOG.fine(String.format(
          Locale.ROOT, "Network lost: %s", connectivityManager.getNetworkInfo(network)));
      NetworkInfo activeNetworkInfo = connectivityManager.getActiveNetworkInfo();
      if (activeNetworkInfo != null
          && activeNetworkInfo.getState() == NetworkInfo.State.CONNECTED) {
        return;
      }
      broadcastVpnConnectivityChange(TunnelStatus.RECONNECTING);
      updateNotification(TunnelStatus.RECONNECTING);
    }
  }

  private void startNetworkConnectivityMonitor() {
    final ConnectivityManager connectivityManager =
        (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    NetworkRequest request = new NetworkRequest.Builder()
                                 .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                                 .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
                                 .build();
    // `registerNetworkCallback` returns the VPN interface as the default network since Android P.
    // Use `requestNetwork` instead (requires android.permission.CHANGE_NETWORK_STATE).
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      connectivityManager.registerNetworkCallback(request, networkConnectivityMonitor);
    } else {
      connectivityManager.requestNetwork(request, networkConnectivityMonitor);
    }
  }

  // Broadcasts

  /* Broadcast change in the VPN connectivity. */
  private void broadcastVpnConnectivityChange(TunnelStatus status) {
    this.tunnelStore.setTunnelStatus(status);
    QuickSettingsTileService.requestTileUpdate(this);
    // Capture tunnelConfig into a local variable to avoid a TOCTOU race: another thread (e.g.
    // tearDownActiveTunnel) can set the field to null between the null-check and the read below.
    final TunnelConfig config = this.tunnelConfig;
    if (config == null) {
      LOG.warning("Tunnel disconnected, not sending VPN connectivity broadcast");
      return;
    }
    Intent statusChange = new Intent(STATUS_BROADCAST_KEY);
    statusChange.addCategory(getPackageName());
    // We must explicitly set the package for security reasons: https://developer.android.com/about/versions/14/behavior-changes-14#security
    statusChange.setPackage(this.getPackageName());
    statusChange.putExtra(MessageData.PAYLOAD.value, status.value);
    statusChange.putExtra(MessageData.TUNNEL_ID.value, config.id);
    sendBroadcast(statusChange);
  }

  // Autostart

  private void startLastSuccessfulTunnel() {
    LOG.info("Received an auto-connect request, loading last successful tunnel.");
    JSONObject tunnel = tunnelStore.load();

    // Retrieve the server name early so we can pass it to startForegroundWithNotification.
    // Fall back to an empty string when no tunnel is stored.
    String serverName = tunnel != null ? tunnel.optString(TUNNEL_SERVER_NAME, "") : "";

    // Always call startForeground before any early return. Android 8+ requires that a service
    // started via startForegroundService() calls startForeground() within 5 seconds, regardless
    // of the code path taken. Requires android.permission.FOREGROUND_SERVICE since Android P.
    startForegroundWithNotification(serverName);

    if (tunnel == null) {
      LOG.info("Last successful tunnel not found. User not connected at shutdown/install.");
      abortAutoConnect();
      return;
    }
    if (VpnTunnelService.prepare(VpnTunnelService.this) != null) {
      // We cannot prepare the VPN when running as a background service, as it requires UI.
      LOG.warning("VPN not prepared, aborting auto-connect.");
      abortAutoConnect();
      return;
    }
    try {
      final TunnelConfig tunnelConfig = new TunnelConfig();
      tunnelConfig.id = tunnel.getString(TUNNEL_ID_KEY);
      tunnelConfig.name = tunnel.getString(TUNNEL_SERVER_NAME);
      tunnelConfig.transportConfig = tunnel.getString(TUNNEL_CONFIG_KEY);

      startTunnel(tunnelConfig, true);
    } catch (Exception e) {
      LOG.log(Level.SEVERE, "Failed to retrieve JSON tunnel data", e);
      abortAutoConnect();
    }
  }

  /**
   * Cleans up after a failed auto-connect attempt: marks the tunnel as disconnected, refreshes the
   * Quick Settings tile, removes the foreground notification, and stops the service.
   *
   * <p>Centralising these steps avoids repeating the same lifecycle transition in every early-exit
   * path of {@link #startLastSuccessfulTunnel()}.
   *
   * <p>Note: {@link #stopForeground(boolean)} must be called explicitly because {@link #stopSelf()}
   * alone does not dismiss the notification while the service remains bound (e.g. via
   * BIND_AUTO_CREATE from the app or crash-recovery rebind).
   */
  private void abortAutoConnect() {
    tunnelStore.setTunnelStatus(TunnelStatus.DISCONNECTED);
    QuickSettingsTileService.requestTileUpdate(this);
    stopForeground(true);
    stopSelf();
  }

  private void storeActiveTunnel(@NonNull final TunnelConfig config) {
    LOG.info("Storing active tunnel.");
    JSONObject tunnel = new JSONObject();
    try {
      tunnel.put(TUNNEL_ID_KEY, config.id).put(
        TUNNEL_CONFIG_KEY, config.transportConfig).put(TUNNEL_SERVER_NAME, config.name);
      tunnelStore.save(tunnel);
    } catch (JSONException e) {
      LOG.log(Level.SEVERE, "Failed to store JSON tunnel data", e);
    }
    broadcastVpnConnectivityChange(TunnelStatus.CONNECTED);
  }

  // Error reporting

  private void initErrorReporting(final String apiKey) {
    try {
      SentryErrorReporter.init(this, apiKey);
    } catch (Exception e) {
      LOG.log(Level.SEVERE, "Failed to initialize Sentry", e);
    }
  }

  // Foreground service & notifications

  /** Starts the service in the foreground and displays a persistent notification. */
  private void startForegroundWithNotification(final String serverName) {
    try {
      if (notificationBuilder == null) {
        // Cache the notification builder so we can update the existing notification - creating a
        // new notification has the side effect of resetting the tunnel timer.
        notificationBuilder = getNotificationBuilder(serverName);
      }
      notificationBuilder.setContentText(getStringResource("connected_server_state"));

      // We must specify the service type for security reasons: https://developer.android.com/about/versions/14/changes/fgs-types-required
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_SERVICE_ID, notificationBuilder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED);
      }
    } catch (Exception e) {
      LOG.warning("Unable to display persistent notification");
    }
  }

  /** Updates the persistent notification to reflect the tunnel status. */
  private void updateNotification(TunnelStatus status) {
    try {
      if (notificationBuilder == null) {
        return; // No notification to update.
      }
      final String statusStringResourceId = status == TunnelStatus.CONNECTED
          ? "connected_server_state"
          : "reconnecting_server_state";
      notificationBuilder.setContentText(getStringResource(statusStringResourceId));
      NotificationManager notificationManager =
          (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      notificationManager.notify(NOTIFICATION_SERVICE_ID, notificationBuilder.build());
    } catch (Exception e) {
      LOG.warning("Failed to update persistent notification");
    }
  }

  /** Returns a notification builder with the provided server name. */
  @NonNull
  private Notification.Builder getNotificationBuilder(final String serverName) throws Exception {
    // HACK: tapping the notification opens whatever the host app's launcher activity is, because
    // this library has no way to know the app's activity class. The Cordova and Capacitor apps
    // name it differently (org.outline.android.client.MainActivity vs.
    // org.outline.client.MainActivity), and the app cannot hand it to the service either: the
    // service also runs without the app, when started at boot, by always-on VPN, or from the
    // Quick Settings tile. Resolving the launcher activity through the PackageManager works for
    // both apps, but it only holds as long as the activity the notification should open is the
    // app's launcher activity.
    // TODO: once the Cordova app is deleted, drop this and open org.outline.client.MainActivity
    // directly.
    Intent launchIntent = Objects.requireNonNull(
        getPackageManager().getLaunchIntentForPackage(getPackageName()),
        "no launcher activity");
    PendingIntent mainActivityIntent = PendingIntent.getActivity(
        this, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Notification.Builder builder;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
          NOTIFICATION_CHANNEL_ID, "Outline", NotificationManager.IMPORTANCE_LOW);
      NotificationManager notificationManager = getSystemService(NotificationManager.class);
      notificationManager.createNotificationChannel(channel);
      builder = new Notification.Builder(this, NOTIFICATION_CHANNEL_ID);
    } else {
      builder = new Notification.Builder(this);
    }
    try {
      // TODO(fortuna): use R.drawable.small_icon instead. Needs moving resource from plugin to OutlineAndroidLib.
      builder.setSmallIcon(getResourceId("small_icon", "drawable"));
    } catch (Exception e) {
      LOG.warning("Failed to retrieve the resource ID for the notification icon.");
    }
    return builder.setContentTitle(serverName)
        .setColor(NOTIFICATION_COLOR)
        .setVisibility(Notification.VISIBILITY_SECRET) // Don't display in lock screen
        .setContentIntent(mainActivityIntent)
        .setShowWhen(true)
        .setUsesChronometer(true);
  }

  /** Stops the foreground service and removes the persistent notification. */
  private void stopForeground() {
    stopForeground(true /* remove notification */);
    notificationBuilder = null;
  }

  /** Retrieves the ID for a resource. This is equivalent to using the generated R class. */
  public int getResourceId(final String name, final String type) {
    return getResources().getIdentifier(name, type, getPackageName());
  }

  /** Returns the application name. */
  @NonNull
  public final String getApplicationName() throws PackageManager.NameNotFoundException {
    PackageManager packageManager = getApplicationContext().getPackageManager();
    ApplicationInfo appInfo = packageManager.getApplicationInfo(getPackageName(), 0);
    return (String) packageManager.getApplicationLabel(appInfo);
  }

  /** Retrieves a localized string by id from the application's resources. */
  private String getStringResource(final String name) {
    String resource = "";
    try {
      resource = getString(getResourceId(name, "string"));
    } catch (Exception e) {
      LOG.warning(String.format(Locale.ROOT, "Failed to retrieve string resource: %s", name));
    }
    return resource;
  }

  /** Returns a subnet list that excludes reserved subnets. */
  @NonNull
  private ArrayList<Subnet> getReservedBypassSubnets() {
    final String[] subnetStrings = this.getResources().getStringArray(
            this.getResourceId("reserved_bypass_subnets", "array"));
    ArrayList<Subnet> subnets = new ArrayList<>(subnetStrings.length);
    for (final String subnetString : subnetStrings) {
      try {
        subnets.add(Subnet.parse(subnetString));
      } catch (Exception e) {
        LOG.warning(String.format(Locale.ROOT, "Failed to parse subnet: %s", subnetString));
      }
    }
    return subnets;
  }

  /** Represents an IP subnet. */
  private static class Subnet {
    public String address;
    public int prefix;

    public Subnet(String address, int prefix) {
      this.address = address;
      this.prefix = prefix;
    }

    /** Parses a subnet in CIDR format. */
    @NonNull
    public static Subnet parse(@NonNull final String subnet) throws IllegalArgumentException {
      final String[] components = subnet.split("/", 2);
      if (components.length != 2) {
        throw new IllegalArgumentException("Malformed subnet string");
      }
      return new Subnet(components[0], Integer.parseInt(components[1]));
    }
  }
}
