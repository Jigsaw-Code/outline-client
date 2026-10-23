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
import android.os.RemoteException;
import androidx.annotation.Nullable;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
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
import org.outline.vpn.Errors;
import org.outline.vpn.QuickSettingsTileService;
import org.outline.vpn.VpnServiceStarter;
import org.outline.vpn.VpnTunnelService;
import org.outline.vpn.VpnTunnelStore;

import outline.GoBackendConfig;
import outline.Outline;
import outline.InvokeMethodResult;
import platerrors.Platerrors;
import platerrors.PlatformError;

import static org.outline.vpn.VpnTunnelService.MessageData;
import static org.outline.vpn.VpnTunnelService.TunnelStatus;

public class OutlinePlugin extends CordovaPlugin {
  private static final Logger LOG = Logger.getLogger(OutlinePlugin.class.getName());

  // Actions supported by this plugin.
  public enum Action {
    INVOKE_METHOD("invokeMethod"),
    START("start"),
    STOP("stop"),
    ON_STATUS_CHANGE("onStatusChange"),
    IS_RUNNING("isRunning"),
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
  // Must match outline.MethodEraseServiceStorage in the Go method channel.
  private static final String METHOD_ERASE_SERVICE_STORAGE = "EraseServiceStorage";

  // AIDL interface for VpnTunnelService, which is bound for the lifetime of this class.
  // The VpnTunnelService runs in a sub process and is thread-safe.
  // A race condition may occur when calling methods on this instance if the service unbinds.
  // We catch any exceptions, which should generally be transient and recoverable, and report them
  // to the WebView.
  private IVpnTunnelService vpnTunnelService;
  private String errorReportingApiKey;
  private StartVpnRequest startVpnRequest;
  // Tunnel status change callback.
  private CallbackContext statusCallback;

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

    final GoBackendConfig goConfig = Outline.getBackendConfig();
    goConfig.setDataDir(context.getFilesDir().getAbsolutePath());

    IntentFilter broadcastFilter = new IntentFilter();
    broadcastFilter.addAction(VpnTunnelService.STATUS_BROADCAST_KEY);
    broadcastFilter.addCategory(context.getPackageName());
    context.registerReceiver(vpnTunnelBroadcastReceiver, broadcastFilter, context.RECEIVER_NOT_EXPORTED);

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
  public boolean execute(String action, JSONArray args, CallbackContext callbackContext) {
    if (!Action.hasValue(action)) {
      return false;
    }
    if (Action.QUIT.is(action)) {
      this.cordova.getActivity().finish();
      return true;
    }

    LOG.fine(String.format(Locale.ROOT, "Received action: %s", action));

    if (Action.ON_STATUS_CHANGE.is(action)) {
      this.statusCallback = callbackContext;
      // TODO(fortuna): unregister original with Cordova.
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
        sendActionResult(callbackContext, new PlatformError(Platerrors.InternalError, e.toString()));
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
        if (Action.INVOKE_METHOD.is(action)) {
          final String methodName = args.getString(0);
          final String input = args.getString(1);
          // Forgetting a server erases Go per-service files but previously left the
          // Java VpnTunnelStore intact, so the Quick Settings tile could reconnect
          // to a removed server. Clear the store when the forgotten id matches.
          if (METHOD_ERASE_SERVICE_STORAGE.equals(methodName)) {
            clearTunnelStoreIfMatches(input);
          }
          LOG.fine(String.format(Locale.ROOT, "Calling InvokeMethod(%s, %s)", methodName, input));
          final InvokeMethodResult result = Outline.invokeMethod(methodName, input);
          if (result.getError() != null) {
            LOG.warning(String.format(Locale.ROOT, "InvokeMethod(%s) failed: %s", methodName, result.getError()));
            sendActionResult(callback, result.getError());
          } else {
            LOG.fine(String.format(Locale.ROOT, "InvokeMethod(%s) result: %s", methodName, result.getValue()));
            callback.success(result.getValue());
          }

        // Tunnel instance actions: tunnel ID is always the first argument.
        } else if (Action.START.is(action)) {
          final String tunnelId = args.getString(0);
          final String serverName = args.getString(1);
          final String transportConfig = args.getString(2);
          sendActionResult(callback, startVpnTunnel(tunnelId, transportConfig, serverName));
        } else if (Action.STOP.is(action)) {
          final String tunnelId = args.getString(0);
          LOG.info(String.format(Locale.ROOT, "Stopping VPN tunnel %s", tunnelId));
          sendActionResult(callback, vpnTunnelService.stopTunnel(tunnelId));
        } else if (Action.IS_RUNNING.is(action)) {
          final String tunnelId = args.getString(0);
          boolean isActive = isTunnelActive(tunnelId);
          callback.sendPluginResult(new PluginResult(PluginResult.Status.OK, isActive));

          // Static actions
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
        sendActionResult(callback, new PlatformError(Platerrors.InternalError, e.toString()));
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
      sendActionResult(startVpnRequest.callback, new PlatformError(
          Platerrors.VPNPermissionNotGranted, "failed to grant the VPN permission"));
      return;
    }
    executeAsync(Action.START.value, startVpnRequest.args, startVpnRequest.callback);
    startVpnRequest = null;
  }

  private DetailedJsonError startVpnTunnel(
      final String tunnelId, final String transportConfig, final String serverName
  ) throws RemoteException {
    LOG.info(String.format(Locale.ROOT, "Starting VPN tunnel %s for server %s", tunnelId, serverName));
    final TunnelConfig tunnelConfig = new TunnelConfig();
    tunnelConfig.id = tunnelId;
    tunnelConfig.name = serverName;
    tunnelConfig.transportConfig = transportConfig;
    return vpnTunnelService.startTunnel(tunnelConfig);
  }

  // Returns whether the VPN service is running a particular tunnel instance.
  private boolean isTunnelActive(final String tunnelId) {
    try {
      return vpnTunnelService.isTunnelActive(tunnelId);
    } catch (Exception e) {
      LOG.log(Level.SEVERE,
          String.format(Locale.ROOT, "Failed to determine if tunnel is active: %s", tunnelId), e);
    }
    return false;
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
      if (outlinePlugin.statusCallback == null) {
        LOG.warning(String.format(
            Locale.ROOT, "No status callback registered with the Android OutlinePlugin"));
        return;
      }
      int status = intent.getIntExtra(MessageData.PAYLOAD.value, TunnelStatus.INVALID.value);
      LOG.fine(String.format(Locale.ROOT, "VPN connectivity changed: %s, %d", tunnelId, status));

      JSONObject jsonResponse = new JSONObject();
      try {
        jsonResponse.put("id", tunnelId);
        jsonResponse.put("status", status);
      } catch (JSONException e) {
        LOG.warning("Failed to build JSON response");
        return;
      }

      PluginResult result = new PluginResult(PluginResult.Status.OK, jsonResponse);
      // Keep the tunnel status callback so it can be called multiple times.
      result.setKeepCallback(true);
      outlinePlugin.statusCallback.sendPluginResult(result);
    }
  };

  // Helpers

  /**
   * Clears {@link VpnTunnelStore} when {@code serviceId} matches the persisted tunnel id.
   * Do not clear on disconnect — that would break boot / always-on auto-start.
   */
  private void clearTunnelStoreIfMatches(final String serviceId) {
    if (serviceId == null || serviceId.isEmpty()) {
      return;
    }
    try {
      final VpnTunnelStore store = new VpnTunnelStore(getBaseContext());
      final JSONObject stored = store.load();
      if (stored != null && serviceId.equals(stored.optString("id"))) {
        store.clear();
        QuickSettingsTileService.requestTileUpdate(getBaseContext());
      }
    } catch (Exception e) {
      // Erase must still reach Go even if the Java store clear fails.
      LOG.log(Level.WARNING, "Failed to clear VPN tunnel store after erase", e);
    }
  }

  private Context getBaseContext() {
    return this.cordova.getActivity().getApplicationContext();
  }

  private void sendActionResult(final CallbackContext callback, @Nullable PlatformError error) {
    sendActionResult(callback, Errors.toDetailedJsonError(error));
  }

  private void sendActionResult(final CallbackContext callback, @Nullable DetailedJsonError error) {
    if (error == null) {
      callback.success();
    } else {
      callback.error(error.errorJson);
    }
  }
}
