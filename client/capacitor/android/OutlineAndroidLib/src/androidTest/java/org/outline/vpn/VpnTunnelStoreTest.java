// Copyright 2022 The Outline Authors
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

import static org.junit.Assert.*;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

public class VpnTunnelStoreTest {

    private VpnTunnelStore store;
    private JSONObject info;

    @Before
    public void setUp() throws Exception {
        final Context context = ApplicationProvider.getApplicationContext();

        store = new VpnTunnelStore(context);

        info = new JSONObject();
        info.put("foo", "bar");
    }

    @Test
    public void tunnelInfo() {
        store.save(info);
        final JSONObject info2 = store.load();
        assertEquals(info.toString(), info2.toString());
        assertFalse(info == info2);
    }

    @Test
    public void tunnelStatus() {
        store.setTunnelStatus(VpnTunnelService.TunnelStatus.RECONNECTING);
        assertEquals(VpnTunnelService.TunnelStatus.RECONNECTING, store.getTunnelStatus());
    }

    @Test
    public void udpSupport() {
        store.setIsUdpSupported(true);
        assertTrue(store.isUdpSupported());
        store.setIsUdpSupported(false);
        assertFalse(store.isUdpSupported());
    }

    @Test
    public void clear() {
        store.save(info);
        store.setTunnelStatus(VpnTunnelService.TunnelStatus.CONNECTED);
        store.setIsUdpSupported(true);

        store.clear();

        assertNull(store.load());
        // clear() does not reset the tunnel status or UDP state.
        assertEquals(VpnTunnelService.TunnelStatus.CONNECTED, store.getTunnelStatus());
        assertTrue(store.isUdpSupported());
    }

}
