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

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;

// Starts the VpnTunnelService on boot and after app updates. Receives broadcasts for
// android.intent.action.BOOT_COMPLETED and android.intent.action.MY_PACKAGE_REPLACED.
public class VpnServiceStarter extends BroadcastReceiver {
  public static final String AUTOSTART_EXTRA = "autostart";

  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null) {
      return;
    }
    
    final String action = intent.getAction();
    if (action == null
        || (!Intent.ACTION_BOOT_COMPLETED.equals(action)
            && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action))) {
      return;
    }
    
    final VpnTunnelStore tunnelStore = new VpnTunnelStore(context);
    boolean wasConnectedAtShutdown =
        VpnTunnelService.TunnelStatus.CONNECTED.equals(tunnelStore.getTunnelStatus());
    if (!wasConnectedAtShutdown) {
      return;
    }
    // The VPN cannot be prepared from the background (it requires UI). If consent is missing (e.g.
    // revoked, or granted to another VPN app), don't start the service: once
    // startForegroundService() is called, Android requires the service to call startForeground()
    // in time, and the service would immediately abort anyway. Clear the stale status instead.
    final boolean vpnConsentGranted = VpnService.prepare(context) == null;
    if (!AutoStartPolicy.shouldStartService(wasConnectedAtShutdown, vpnConsentGranted)) {
      tunnelStore.setTunnelStatus(VpnTunnelService.TunnelStatus.DISCONNECTED);
      return;
    }
    Intent serviceIntent = new Intent(context, VpnTunnelService.class);
    serviceIntent.putExtra(AUTOSTART_EXTRA, true);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(serviceIntent);
    } else {
      context.startService(serviceIntent);
    }
  }
}
