// Copyright 2024 The Outline Authors
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

import java.util.Locale;
import java.util.logging.Logger;
import org.outline.DetailedJsonError;
import platerrors.Platerrors;
import platerrors.PlatformError;

/**
 * This class provides helper methods related to error objects.
 */
public class Errors {
  private static final Logger LOG = Logger.getLogger(Errors.class.getName());

  public static DetailedJsonError toDetailedJsonError(final PlatformError err) {
    if (err == null) {
      return null;
    }

    final DetailedJsonError svcErr = new DetailedJsonError();
    svcErr.code = err.getCode();

    try {
      svcErr.errorJson = Platerrors.marshalJSONString(err);
    } catch (final Exception ex) {
      LOG.warning(String.format(Locale.ROOT, "failed to marshal PlatformError to JSON: %s", ex));
      // TypeScript's PlatformError is able to parse non-json strings as well
      svcErr.errorJson = String.format(Locale.ROOT,
          "error code = %s, failed to fetch details",
          svcErr.code);
    }

    return svcErr;
  }
}
