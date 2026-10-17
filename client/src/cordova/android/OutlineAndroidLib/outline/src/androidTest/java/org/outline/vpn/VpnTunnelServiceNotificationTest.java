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
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.app.Notification;
import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;

/**
 * Regression tests for OUTLINE-CLIENTS-NE2GP: the foreground notification must build even when
 * app resources are missing, otherwise startForeground() is never called.
 */
public class VpnTunnelServiceNotificationTest {
  private Context context;

  @Before
  public void setUp() {
    context = ApplicationProvider.getApplicationContext();
  }

  @Test
  public void missingLauncherActivity_buildsNotificationWithoutTapAction() {
    final Notification notification =
        VpnTunnelService.buildNotification(context, "server", null, android.R.drawable.ic_dialog_info)
            .build();

    assertNull(notification.contentIntent);
    assertEquals(android.R.drawable.ic_dialog_info, notification.getSmallIcon().getResId());
  }

  @Test
  public void missingSmallIcon_buildsNotificationWithFallbackIcon() {
    final Notification notification =
        VpnTunnelService.buildNotification(context, "server", null, 0).build();

    assertNotNull(notification.getSmallIcon());
    assertEquals(AutoStartPolicy.FALLBACK_SMALL_ICON, notification.getSmallIcon().getResId());
  }

  @Test
  public void launcherActivityPresent_setsTapAction() {
    final Intent launchIntent = new Intent(Intent.ACTION_MAIN).setPackage(context.getPackageName());
    final Notification notification =
        VpnTunnelService.buildNotification(context, "server", launchIntent, 0).build();

    assertNotNull(notification.contentIntent);
  }
}
