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

import android.content.Context;
import android.content.SharedPreferences;
import java.util.logging.Logger;
import org.json.JSONException;
import org.json.JSONObject;

// Persistence layer for a single tunnel configuration. Uses |SharedPreferences| as the store.
class VpnTunnelStore {
  private static final Logger LOG = Logger.getLogger(VpnTunnelStore.class.getName());
  // TODO(alalama): s/connection/tunnel when update the schema.
  private static final String TUNNEL_KEY = "connection";
  private static final String TUNNEL_STATUS_KEY = "connectionStatus";
  private static final String TUNNEL_SUPPORTS_UDP = "connectionSupportsUdp";

  private final SharedPreferences preferences;

  public VpnTunnelStore(Context context) {
    this.preferences =
        context.getSharedPreferences(VpnTunnelStore.class.getName(), Context.MODE_PRIVATE);
  }

  public void save(final JSONObject tunnel) {
    if (tunnel == null) {
      LOG.severe("Received null JSON tunnel");
      return;
    }
    SharedPreferences.Editor editor = preferences.edit();
    editor.putString(TUNNEL_KEY, tunnel.toString()).commit();
  }

  public JSONObject load() {
    final String jsonTunnel = preferences.getString(TUNNEL_KEY, null);
    if (jsonTunnel == null) {
      return null;
    }
    JSONObject tunnel = null;
    try {
      tunnel = new JSONObject(jsonTunnel);
    } catch (JSONException e) {
      LOG.severe("Failed to deserialize JSON tunnel");
    }
    return tunnel;
  }

  public void clear() {
    SharedPreferences.Editor editor = preferences.edit();
    editor.remove(TUNNEL_KEY).commit();
  }

  public VpnTunnelService.TunnelStatus getTunnelStatus() {
    final String tunnelStatus = preferences.getString(
        TUNNEL_STATUS_KEY, VpnTunnelService.TunnelStatus.DISCONNECTED.toString());
    return VpnTunnelService.TunnelStatus.valueOf(tunnelStatus);
  }

  public void setTunnelStatus(VpnTunnelService.TunnelStatus status) {
    if (status == null) {
      LOG.severe("Received null tunnel status");
      return;
    }
    SharedPreferences.Editor editor = preferences.edit();
    editor.putString(TUNNEL_STATUS_KEY, status.toString()).commit();
  }

  @Deprecated
  public void setIsUdpSupported(boolean isUdpSupported) {
    SharedPreferences.Editor editor = preferences.edit();
    editor.putBoolean(TUNNEL_SUPPORTS_UDP, isUdpSupported).commit();
  }

  @Deprecated
  public boolean isUdpSupported() {
    return preferences.getBoolean(TUNNEL_SUPPORTS_UDP, false);
  }
}
