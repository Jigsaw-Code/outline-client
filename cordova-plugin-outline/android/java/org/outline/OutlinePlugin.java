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

package org.outline;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.net.VpnService;
import android.os.IBinder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.outline.log.OutlineLogger;
import org.outline.log.SentryErrorReporter;
import org.outline.net.Https;
import org.outline.shadowsocks.ShadowsocksConnectivity;
import org.outline.vpn.VpnServiceStarter;
import org.outline.vpn.VpnTunnelService;

public class OutlinePlugin extends CordovaPlugin {
  private static final Logger LOG = Logger.getLogger(OutlinePlugin.class.getName());

  // Actions supported by this plugin.
  public enum Action {
    START("start"),
    STOP("stop"),
    ON_STATUS_CHANGE("onStatusChange"),
    IS_RUNNING("isRunning"),
    IS_REACHABLE("isServerReachable"),
    FETCH_HTTPS("fetchHttps"),
    INIT_ERROR_REPORTING("initializeErrorReporting"),
    REPORT_EVENTS("reportEvents"),
    QUIT("quitApplication");

    private final static Map<String, Action> actions = new HashMap<>();
    static {
      for (Action action : Action.values()) {
        actions.put(action.value, action);
      }
    }

    // Returns whether |value| is a defined action.
    public static boolean hasValue(final String value) {
      return actions.containsKey(value);
    }

    public final String value;
    Action(final String value) {
      this.value = value;
    }

    // Returns whether |action| is the underlying value of this instance.
    public boolean is(final String action) {
      return this.value.equals(action);
    }
  }

  // Plugin error codes. Keep in sync with outlinePlugin.js.
  public enum ErrorCode {
    NO_ERROR(0),
    UNEXPECTED(1),
    VPN_PERMISSION_NOT_GRANTED(2),
    INVALID_SERVER_CREDENTIALS(3),
    UDP_RELAY_NOT_ENABLED(4),
    SERVER_UNREACHABLE(5),
    VPN_START_FAILURE(6),
    ILLEGAL_SERVER_CONFIGURATION(7),
    SHADOWSOCKS_START_FAILURE(8),
    CONFIGURE_SYSTEM_PROXY_FAILURE(9),
    NO_ADMIN_PERMISSIONS(10),
    UNSUPPORTED_ROUTING_TABLE(11),
    SYSTEM_MISCONFIGURED(12);

    public final int value;
    ErrorCode(int value) {
      this.value = value;
    }
  }

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
    TUNNEL_CONFIG("tunnelConfig"),
    ACTION("action"),
    PAYLOAD("payload"),
    ERROR_REPORTING_API_KEY("errorReportingApiKey");

    public final String value;
    MessageData(final String value) {
      this.value = value;
    }
  }

  // Encapsulates parameters to start the VPN asynchronously after requesting user permission.
  private static class StartVpnRequest {
    public final JSONArray args;
    public final CallbackContext callback;
    public StartVpnRequest(JSONArray args, CallbackContext callback) {
      this.args = args;
      this.callback = callback;
    }
  }

  private static final int REQUEST_CODE_PREPARE_VPN = 100;

  // AIDL interface for VpnTunnelService, which is bound for the lifetime of this class.
  // The VpnTunnelService runs in a sub process and is thread-safe.
  // A race condition may occur when calling methods on this instance if the service unbinds.
  // We catch any exceptions, which should generally be transient and recoverable, and report them
  // to the WebView.
  private IVpnTunnelService vpnTunnelService;
  private String errorReportingApiKey;
  private StartVpnRequest startVpnRequest;
  // Tunnel status change callback by tunnel ID.
  private final Map<String, CallbackContext> tunnelStatusListeners = new ConcurrentHashMap<>();

  // Connection to the VPN service.
  private final ServiceConnection vpnServiceConnection = new ServiceConnection() {
    @Override
    public void onServiceConnected(ComponentName className, IBinder binder) {
      vpnTunnelService = IVpnTunnelService.Stub.asInterface(binder);
      LOG.info("VPN service connected");
    }

    @Override
    public void onServiceDisconnected(ComponentName className) {
      LOG.warning("VPN service disconnected");
      // Rebind the service so the VPN automatically reconnects if the service process crashed.
      Context context = getBaseContext();
      Intent rebind = new Intent(context, VpnTunnelService.class);
      rebind.putExtra(VpnServiceStarter.AUTOSTART_EXTRA, true);
      // Send the error reporting API key so the potential crash is reported.
      rebind.putExtra(MessageData.ERROR_REPORTING_API_KEY.value, errorReportingApiKey);
      context.bindService(rebind, vpnServiceConnection, Context.BIND_AUTO_CREATE);
    }
  };

  @Override
  protected void pluginInitialize() {
    OutlineLogger.registerLogHandler(SentryErrorReporter.BREADCRUMB_LOG_HANDLER);
    Context context = getBaseContext();
    IntentFilter broadcastFilter = new IntentFilter();
    broadcastFilter.addAction(Action.ON_STATUS_CHANGE.value);
    broadcastFilter.addCategory(context.getPackageName());
    context.registerReceiver(vpnTunnelBroadcastReceiver, broadcastFilter);

    context.bindService(new Intent(context, VpnTunnelService.class), vpnServiceConnection,
        Context.BIND_AUTO_CREATE);
  }

  @Override
  public void onDestroy() {
    Context context = getBaseContext();
    context.unregisterReceiver(vpnTunnelBroadcastReceiver);
    context.unbindService(vpnServiceConnection);
  }

  @Override
  public boolean execute(String action, JSONArray args, CallbackContext callbackContext)
      throws JSONException {
    if (!Action.hasValue(action)) {
      return false;
    }
    if (Action.QUIT.is(action)) {
      this.cordova.getActivity().finish();
      return true;
    }

    LOG.fine(String.format(Locale.ROOT, "Received action: %s", action));

    if (Action.ON_STATUS_CHANGE.is(action)) {
      // Store the callback so we can execute it asynchronously.
      final String tunnelId = args.getString(0);
      tunnelStatusListeners.put(tunnelId, callbackContext);
      return true;
    }

    if (Action.START.is(action)) {
      // Prepare the VPN before spawning a new thread. Fall through if it's already prepared.
      try {
        if (!prepareVpnService()) {
          startVpnRequest = new StartVpnRequest(args, callbackContext);
          return true;
        }
      } catch (ActivityNotFoundException e) {
        callbackContext.error(ErrorCode.UNEXPECTED.value);
        return true;
      }
    }

    executeAsync(action, args, callbackContext);
    return true;
  }

  // Executes an action asynchronously through the Cordova thread pool.
  private void executeAsync(
      final String action, final JSONArray args, final CallbackContext callback) {
    cordova.getThreadPool().execute(() -> {
      try {
        // Tunnel instance actions: tunnel ID is always the first argument.
        if (Action.START.is(action)) {
          final String tunnelId = args.getString(0);
          final JSONObject config = args.getJSONObject(1);
          int errorCode = startVpnTunnel(tunnelId, config);
          sendErrorCode(callback, errorCode);
        } else if (Action.STOP.is(action)) {
          final String tunnelId = args.getString(0);
          LOG.info(String.format(Locale.ROOT, "Stopping VPN tunnel %s", tunnelId));
          int errorCode = vpnTunnelService.stopTunnel(tunnelId);
          sendErrorCode(callback, errorCode);
        } else if (Action.IS_RUNNING.is(action)) {
          final String tunnelId = args.getString(0);
          boolean isActive = isTunnelActive(tunnelId);
          callback.sendPluginResult(new PluginResult(PluginResult.Status.OK, isActive));

          // Static actions
        } else if (Action.IS_REACHABLE.is(action)) {
          boolean isReachable =
              ShadowsocksConnectivity.isServerReachable(args.getString(0), args.getInt(1));
          callback.sendPluginResult(new PluginResult(PluginResult.Status.OK, isReachable));
        } else if (Action.FETCH_HTTPS.is(action)) {
          try {
            Https.Request request = Https.jsonObjectToRequest(args.getJSONObject(0));
            Https.Response response = Https.fetch(request);
            callback.success(Https.responseToJsonObject(response));
          } catch (Exception e) {
            LOG.log(Level.WARNING, "failed to fetch HTTPS", e);
            callback.error(e.getClass().getSimpleName());
          }
        } else if (Action.INIT_ERROR_REPORTING.is(action)) {
          errorReportingApiKey = args.getString(0);
          // Treat failures to initialize error reporting as unexpected by propagating exceptions.
          SentryErrorReporter.init(getBaseContext(), errorReportingApiKey);
          vpnTunnelService.initErrorReporting(errorReportingApiKey);
          callback.success();
        } else if (Action.REPORT_EVENTS.is(action)) {
          final String uuid = args.getString(0);
          SentryErrorReporter.send(uuid);
          callback.success();
        } else {
          throw new IllegalArgumentException(
              String.format(Locale.ROOT, "Unexpected action %s", action));
        }
      } catch (Exception e) {
        LOG.log(Level.SEVERE,
            String.format(Locale.ROOT, "Unexpected error while executing action: %s", action), e);
        callback.error(ErrorCode.UNEXPECTED.value);
      }
    });
  }

  // Requests user permission to connect the VPN. Returns true if permission was previously granted,
  // and false if the OS prompt will be displayed.
  private boolean prepareVpnService() throws ActivityNotFoundException {
    LOG.fine("Preparing VPN.");
    Intent prepareVpnIntent = VpnService.prepare(getBaseContext());
    if (prepareVpnIntent == null) {
      return true;
    }
    LOG.info("Prepare VPN with activity");
    cordova.startActivityForResult(this, prepareVpnIntent, REQUEST_CODE_PREPARE_VPN);
    return false;
  }

  @Override
  public void onActivityResult(int request, int result, Intent data) {
    if (request != REQUEST_CODE_PREPARE_VPN) {
      LOG.warning("Received non-requested activity result.");
      return;
    }
    if (result != Activity.RESULT_OK) {
      LOG.warning("Failed to prepare VPN.");
      sendErrorCode(startVpnRequest.callback, ErrorCode.VPN_PERMISSION_NOT_GRANTED.value);
      return;
    }
    executeAsync(Action.START.value, startVpnRequest.args, startVpnRequest.callback);
    startVpnRequest = null;
  }

  private int startVpnTunnel(final String tunnelId, final JSONObject config) throws Exception {
    LOG.info(String.format(Locale.ROOT, "Starting VPN tunnel %s", tunnelId));
    final TunnelConfig tunnelConfig;
    try {
      tunnelConfig = VpnTunnelService.makeTunnelConfig(tunnelId, config);
    } catch (Exception e) {
      LOG.log(Level.SEVERE, "Failed to retrieve the tunnel proxy config.", e);
      return ErrorCode.ILLEGAL_SERVER_CONFIGURATION.value;
    }
    return vpnTunnelService.startTunnel(tunnelConfig);
  }

  // Returns whether the VPN service is running a particular tunnel instance.
  private boolean isTunnelActive(final String tunnelId) {
    boolean isActive = false;
    try {
      isActive = vpnTunnelService.isTunnelActive(tunnelId);
    } catch (Exception e) {
      LOG.log(Level.SEVERE,
          String.format(Locale.ROOT, "Failed to determine if tunnel is active: %s", tunnelId), e);
    }
    return isActive;
  }

  // Broadcasts

  private VpnTunnelBroadcastReceiver vpnTunnelBroadcastReceiver =
      new VpnTunnelBroadcastReceiver(OutlinePlugin.this);

  // Receiver to forward VPN service broadcasts to the WebView when the tunnel status changes.
  private static class VpnTunnelBroadcastReceiver extends BroadcastReceiver {
    private final OutlinePlugin outlinePlugin;

    public VpnTunnelBroadcastReceiver(OutlinePlugin outlinePlugin) {
      this.outlinePlugin = outlinePlugin;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
      final String tunnelId = intent.getStringExtra(MessageData.TUNNEL_ID.value);
      if (tunnelId == null) {
        LOG.warning("Tunnel status broadcast missing tunnel ID");
        return;
      }
      CallbackContext callback = outlinePlugin.tunnelStatusListeners.get(tunnelId);
      if (callback == null) {
        LOG.warning(String.format(
            Locale.ROOT, "Failed to retrieve status listener for tunnel ID %s", tunnelId));
        return;
      }
      int status = intent.getIntExtra(MessageData.PAYLOAD.value, TunnelStatus.INVALID.value);
      LOG.fine(String.format(Locale.ROOT, "VPN connectivity changed: %s, %d", tunnelId, status));

      PluginResult result = new PluginResult(PluginResult.Status.OK, status);
      // Keep the tunnel status callback so it can be called multiple times.
      result.setKeepCallback(true);
      callback.sendPluginResult(result);
    }
  };

  // Helpers

  private Context getBaseContext() {
    return this.cordova.getActivity().getApplicationContext();
  }

  private void sendErrorCode(final CallbackContext callback, int errorCode) {
    if (errorCode == ErrorCode.NO_ERROR.value) {
      callback.success();
    } else {
      callback.error(errorCode);
    }
  }
}
