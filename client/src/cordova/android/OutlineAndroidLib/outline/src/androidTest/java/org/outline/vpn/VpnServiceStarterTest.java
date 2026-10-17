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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assume.assumeTrue;

import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.net.VpnService;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;

/** Regression tests for OUTLINE-CLIENTS-NE2GP (ForegroundServiceDidNotStartInTimeException). */
public class VpnServiceStarterTest {

  /** Records service start requests instead of starting the service. */
  private static class RecordingContext extends ContextWrapper {
    Intent startedService;

    RecordingContext(Context base) {
      super(base);
    }

    @Override
    public ComponentName startForegroundService(Intent service) {
      startedService = service;
      return service.getComponent();
    }

    @Override
    public ComponentName startService(Intent service) {
      startedService = service;
      return service.getComponent();
    }
  }

  private RecordingContext context;
  private VpnTunnelStore tunnelStore;

  @Before
  public void setUp() {
    context = new RecordingContext(ApplicationProvider.getApplicationContext());
    tunnelStore = new VpnTunnelStore(context);
  }

  @Test
  public void bootWithoutVpnConsent_clearsStatusAndDoesNotStartService() {
    // The test package has never been granted VPN consent on a clean device/emulator.
    assumeTrue(VpnService.prepare(context) != null);
    tunnelStore.setTunnelStatus(VpnTunnelService.TunnelStatus.CONNECTED);

    new VpnServiceStarter().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));

    assertNull(context.startedService);
    assertEquals(VpnTunnelService.TunnelStatus.DISCONNECTED, tunnelStore.getTunnelStatus());
  }

  @Test
  public void packageReplacedWithoutVpnConsent_clearsStatusAndDoesNotStartService() {
    assumeTrue(VpnService.prepare(context) != null);
    tunnelStore.setTunnelStatus(VpnTunnelService.TunnelStatus.CONNECTED);

    new VpnServiceStarter().onReceive(context, new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));

    assertNull(context.startedService);
    assertEquals(VpnTunnelService.TunnelStatus.DISCONNECTED, tunnelStore.getTunnelStatus());
  }

  @Test
  public void notConnectedAtShutdown_doesNotStartService() {
    tunnelStore.setTunnelStatus(VpnTunnelService.TunnelStatus.DISCONNECTED);

    new VpnServiceStarter().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));

    assertNull(context.startedService);
  }

  @Test
  public void unrelatedAction_doesNotStartService() {
    tunnelStore.setTunnelStatus(VpnTunnelService.TunnelStatus.CONNECTED);

    new VpnServiceStarter().onReceive(context, new Intent(Intent.ACTION_SCREEN_ON));

    assertNull(context.startedService);
    assertEquals(VpnTunnelService.TunnelStatus.CONNECTED, tunnelStore.getTunnelStatus());
  }
}
