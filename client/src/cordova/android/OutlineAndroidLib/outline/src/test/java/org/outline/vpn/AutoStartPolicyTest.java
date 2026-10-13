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
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Regression tests for OUTLINE-CLIENTS-NE2GP (ForegroundServiceDidNotStartInTimeException). */
public class AutoStartPolicyTest {

  @Test
  public void shouldStartService_connectedWithConsent() {
    assertTrue(AutoStartPolicy.shouldStartService(true, true));
  }

  @Test
  public void shouldStartService_missingConsentDoesNotStart() {
    // Starting the service without consent would force it to abort before calling
    // startForeground(), crashing the app.
    assertFalse(AutoStartPolicy.shouldStartService(true, false));
  }

  @Test
  public void shouldStartService_notConnectedDoesNotStart() {
    assertFalse(AutoStartPolicy.shouldStartService(false, true));
    assertFalse(AutoStartPolicy.shouldStartService(false, false));
  }

  @Test
  public void decideAutoConnect_allConditionsMetStartsTunnel() {
    assertEquals(AutoStartPolicy.Decision.START_TUNNEL,
        AutoStartPolicy.decideAutoConnect(true, true, true));
  }

  @Test
  public void decideAutoConnect_foregroundFailureAborts() {
    assertEquals(AutoStartPolicy.Decision.ABORT,
        AutoStartPolicy.decideAutoConnect(false, true, true));
  }

  @Test
  public void decideAutoConnect_missingTunnelAborts() {
    assertEquals(AutoStartPolicy.Decision.ABORT,
        AutoStartPolicy.decideAutoConnect(true, false, true));
  }

  @Test
  public void decideAutoConnect_missingConsentAborts() {
    assertEquals(AutoStartPolicy.Decision.ABORT,
        AutoStartPolicy.decideAutoConnect(true, true, false));
  }

  @Test
  public void smallIconOrFallback_keepsResolvedIcon() {
    assertEquals(1234, AutoStartPolicy.smallIconOrFallback(1234));
  }

  @Test
  public void smallIconOrFallback_unresolvedIconUsesFallback() {
    assertEquals(AutoStartPolicy.FALLBACK_SMALL_ICON, AutoStartPolicy.smallIconOrFallback(0));
  }
}
