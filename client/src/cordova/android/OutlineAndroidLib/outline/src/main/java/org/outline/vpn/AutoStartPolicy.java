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

/**
 * Decision logic for the VPN auto-start path (boot, package update, always-on).
 *
 * <p>Kept free of Android framework calls so it can be covered by local unit tests. Once
 * Context.startForegroundService() is called, Android kills the app unless the service calls
 * Service.startForeground() in time, so these rules decide when the service may be started and
 * when an auto-connect must be aborted.
 */
final class AutoStartPolicy {
  /** Icon used for the foreground notification when the app's small_icon cannot be resolved. */
  static final int FALLBACK_SMALL_ICON = android.R.drawable.ic_lock_lock;

  /** Outcome of an auto-connect attempt inside the service. */
  enum Decision {
    START_TUNNEL,
    ABORT,
  }

  private AutoStartPolicy() {}

  /**
   * Whether VpnServiceStarter should start the service in the foreground.
   *
   * @param wasConnected whether the stored tunnel status was CONNECTED.
   * @param vpnConsentGranted whether VpnService.prepare() returned null.
   */
  static boolean shouldStartService(boolean wasConnected, boolean vpnConsentGranted) {
    return wasConnected && vpnConsentGranted;
  }

  /**
   * Whether the service should go on to start the tunnel or abort the auto-connect.
   *
   * @param startedInForeground whether Service.startForeground() succeeded.
   * @param hasStoredTunnel whether a last successful tunnel was found.
   * @param vpnConsentGranted whether VpnService.prepare() returned null.
   */
  static Decision decideAutoConnect(
      boolean startedInForeground, boolean hasStoredTunnel, boolean vpnConsentGranted) {
    if (!startedInForeground || !hasStoredTunnel || !vpnConsentGranted) {
      return Decision.ABORT;
    }
    return Decision.START_TUNNEL;
  }

  /** Returns the resolved small icon resource ID, or a fallback if it couldn't be resolved. */
  static int smallIconOrFallback(int resolvedIconId) {
    return resolvedIconId != 0 ? resolvedIconId : FALLBACK_SMALL_ICON;
  }
}
