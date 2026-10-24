// Copyright 2026 The Outline Authors
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

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import java.util.logging.Logger;

/**
 * Quick Settings tile for toggling the last successfully connected Outline tunnel.
 */
public class QuickSettingsTileService extends TileService {
  private static final Logger LOG = Logger.getLogger(QuickSettingsTileService.class.getName());

  private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
    @Override
    public void onReceive(Context context, Intent intent) {
      updateTile();
    }
  };
  private boolean statusReceiverRegistered;

  public static void requestTileUpdate(Context context) {
    TileService.requestListeningState(
        context,
        new ComponentName(context, QuickSettingsTileService.class));
  }

  @Override
  public void onStartListening() {
    registerStatusReceiver();
    updateTile();
  }

  @Override
  public void onStopListening() {
    unregisterStatusReceiver();
  }

  @Override
  public IBinder onBind(Intent intent) {
    requestTileUpdate(this);
    return super.onBind(intent);
  }

  @Override
  public void onClick() {
    super.onClick();

    VpnTunnelStore tunnelStore = new VpnTunnelStore(this);
    boolean activationRequested = isActivationRequested(tunnelStore.getTunnelStatus());
    if (activationRequested) {
      tunnelStore.setTunnelStatus(VpnTunnelService.TunnelStatus.DISCONNECTED);
      setTileState(Tile.STATE_INACTIVE);
      setVpnRunning(false);
      return;
    }

    if (tunnelStore.load() == null || VpnService.prepare(this) != null) {
      openApp();
      return;
    }

    tunnelStore.setTunnelStatus(VpnTunnelService.TunnelStatus.RECONNECTING);
    setTileState(Tile.STATE_ACTIVE);
    setVpnRunning(true);
  }

  private void updateTile() {
    setTileState(isActivationRequested(new VpnTunnelStore(this).getTunnelStatus())
        ? Tile.STATE_ACTIVE
        : Tile.STATE_INACTIVE);
  }

  private void setTileState(int state) {
    Tile tile = getQsTile();
    if (tile == null) {
      return;
    }
    tile.setState(state);
    tile.updateTile();
  }

  private boolean isActivationRequested(VpnTunnelService.TunnelStatus status) {
    return status == VpnTunnelService.TunnelStatus.CONNECTED
        || status == VpnTunnelService.TunnelStatus.RECONNECTING;
  }

  private void setVpnRunning(boolean running) {
    Intent intent = new Intent(this, VpnTunnelService.class);
    intent.putExtra(
        running
            ? VpnTunnelService.START_LAST_TUNNEL_EXTRA
            : VpnTunnelService.STOP_ACTIVE_TUNNEL_EXTRA,
        true);
    startService(intent);
  }

  private void registerStatusReceiver() {
    if (statusReceiverRegistered) {
      return;
    }
    IntentFilter filter = new IntentFilter(VpnTunnelService.STATUS_BROADCAST_KEY);
    filter.addCategory(getPackageName());
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
    } else {
      registerReceiver(statusReceiver, filter);
    }
    statusReceiverRegistered = true;
  }

  private void unregisterStatusReceiver() {
    if (!statusReceiverRegistered) {
      return;
    }
    unregisterReceiver(statusReceiver);
    statusReceiverRegistered = false;
  }

  private void openApp() {
    Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
    if (launchIntent == null) {
      LOG.warning("Unable to open Outline from Quick Settings tile.");
      return;
    }
    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      PendingIntent pendingIntent = PendingIntent.getActivity(
          this,
          0,
          launchIntent,
          PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
      startActivityAndCollapse(pendingIntent);
    } else {
      startActivityAndCollapse(launchIntent);
    }
  }
}
