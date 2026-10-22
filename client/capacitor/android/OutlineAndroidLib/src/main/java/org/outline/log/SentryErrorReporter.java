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

package org.outline.log;

import android.content.Context;
import android.util.Log;
import io.sentry.android.core.SentryAndroid;
import io.sentry.Breadcrumb;
import io.sentry.Sentry;
import io.sentry.SentryEvent;
import io.sentry.SentryLevel;
import io.sentry.protocol.Contexts;
import io.sentry.protocol.Device;
import io.sentry.protocol.Message;
import io.sentry.protocol.OperatingSystem;
import java.lang.IllegalStateException;
import java.util.Collection;
import java.util.LinkedList;
import java.util.Locale;
import java.util.Queue;
import java.util.UUID;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;

/**
 * Wrapper class for the Sentry error reporting framework.
 */
public class SentryErrorReporter {
  // Limit the number of breadcrumbs to comply with Outline's data collection
  // policy.
  private static final int MAX_BREADCRUMBS = 100;
  // Reduce the number of VPN service process Sentry error reports by setting a
  // sampling rate.
  private static final double VPN_PROCESS_ERROR_REPORTING_SAMPLE_RATE = 0.75;
  private static final String CATEGORY_VPN_PROCESS = "vpn";

  // Disallow instantiation in favor of a purely static class.
  private SentryErrorReporter() {}

  // Queue of messages waiting to be sent once Sentry is initialized.
  private static Queue<Breadcrumb> breadcrumbsQueue = new LinkedList<>();

  /**
   * Handler that records logs with level INFO and above to Sentry.
   * Exceptions are only logged locally to avoid sending sensitive data to the
   * error reporting
   * framework as part of stack traces.
   */
  public final static Handler BREADCRUMB_LOG_HANDLER = new Handler() {
    @Override
    public void publish(LogRecord record) {
      Level level = record.getLevel();
      String tag = OutlineLogger.loggerNameToTag(record.getLoggerName());
      String msg = record.getMessage();
      try {
        final String breadcrumb = String.format(Locale.ROOT, "%s:%s", tag, msg);
        int levelValue = level.intValue();
        if (levelValue >= Level.SEVERE.intValue()) {
          recordBreadcrumb(breadcrumb, SentryLevel.ERROR);
        } else if (levelValue >= Level.WARNING.intValue()) {
          recordBreadcrumb(breadcrumb, SentryLevel.WARNING);
        } else if (levelValue >= Level.INFO.intValue()) {
          recordBreadcrumb(breadcrumb, SentryLevel.INFO);
        }
      } catch (RuntimeException e) {
        Log.e("SentryLogHandler",
            String.format(Locale.ROOT, "Error logging message: [%tag] %s", tag, msg), e);
      }
    }

    // Must implement abstract methods even though we don't need them.
    @Override
    public void close() throws SecurityException {}

    @Override
    public void flush() {}
  };

  /**
   * Initializes the error reporting framework with the given credentials.
   * Configures an Android uncaught exception handler which sends events to
   * Sentry.
   *
   * @param context Android application Context
   * @param dsn     Sentry API Key
   */
  public static void init(Context context, final String dsn) {
    double sampleRate = isVpnServiceContext(context) ? VPN_PROCESS_ERROR_REPORTING_SAMPLE_RATE : 1;
    SentryAndroid.init(context, options -> {
      options.setDsn(dsn);
      options.setMaxBreadcrumbs(MAX_BREADCRUMBS);
      options.setSampleRate(sampleRate);
      options.setBeforeSend(((event, hint) -> {
        try {
          return removeSentryEventPii(event);
        } catch (Exception e) {
          Log.e(SentryErrorReporter.class.getName(), "Failed to remove PII from Sentry event.", e);
        }
        // Don't send the event if we weren't able to remove PII.
        return null;
      }));
    });

    // Record all queued breadcrumbs.
    while (breadcrumbsQueue.size() > 0) {
      Sentry.addBreadcrumb(breadcrumbsQueue.remove());
    }
  }

  private static boolean isVpnServiceContext(Context context) {
    try {
      return context.getClass().getName().contains("vpn");
    } catch (Exception e) {
      Log.w(SentryErrorReporter.class.getName(), "Failed to determine running context");
    }
    return false;
  }

  /**
   * Sends previously recorded errors and messages to Sentry. Associate the report
   * with the provided event id.
   *
   * @param eventId, unique identifier i.e. the event id for a error report in
   *                 sentry-browser.
   * @throws IllegalStateException when Sentry has not been initialized with an
   *                               API key.
   */
  public static void send(final String eventId) throws IllegalStateException {
    if (!Sentry.isEnabled()) {
      throw new IllegalStateException("Sentry not initialized");
    }
    recordVpnProcessLogs();
    final String uuid = eventId != null ? eventId : UUID.randomUUID().toString();
    // Associate this report with the event ID generated by sentry-browser for
    // cross-referencing.
    // If the ID is not present, use a random UUID to disambiguate the report
    // message so it doesn't
    // get clustered with other reports. Clustering retains the report data on the
    // server side,
    // whereas inactivity results in its deletion after 90 days.
    final SentryEvent event = new SentryEvent();
    final Message message = new Message();
    message.setMessage(String.format(Locale.ROOT, "Android report (%s)", uuid));
    event.setMessage(message);
    event.setTag("user_event_id", uuid);
    Sentry.captureEvent(event);
  }

  private static void recordVpnProcessLogs() {
    // Logs are sorted increasingly by timestamp.
    // Record at most MAX_BREADCRUMBS/2 breadcrumbs from VPN process logs.
    final Collection<String> vpnProcessLogs = OutlineLogger.getVpnProcessLogs(MAX_BREADCRUMBS / 2);
    for (String log : vpnProcessLogs) {
      recordVpnProcessBreadcrumb(log);
    }
  }

  // Record a log message as a breadcrumb to send with the next error report.
  private static void recordBreadcrumb(final String msg, SentryLevel level) {
    final Breadcrumb breadcrumb = new Breadcrumb(msg);
    breadcrumb.setLevel(level);
    addBreadcrumb(breadcrumb);
  }

  private static void recordVpnProcessBreadcrumb(final String msg) {
    final Breadcrumb breadcrumb = new Breadcrumb(msg);
    breadcrumb.setCategory(CATEGORY_VPN_PROCESS);
    addBreadcrumb(breadcrumb);
  }

  private static void addBreadcrumb(Breadcrumb breadcrumb) {
    if (Sentry.isEnabled()) {
      Sentry.addBreadcrumb(breadcrumb);
    } else {
      breadcrumbsQueue.add(breadcrumb);
    }
  }

  // Removes personally identifiably information and unnecessary metadata from a
  // Sentry event.
  // Ensures that the Android device ID is not sent.
  private static SentryEvent removeSentryEventPii(final SentryEvent event) {
    final Contexts contexts = event.getContexts();
    final Device device = contexts.getDevice();
    device.setBootTime(null);
    device.setCharging(null);
    device.setExternalFreeStorage(null);
    device.setExternalStorageSize(null);
    device.setId(null);
    device.setName(null);
    device.setOrientation(null);
    device.setScreenDensity(null);
    device.setScreenDpi(null);
    device.setScreenHeightPixels(null);
    device.setScreenWidthPixels(null);

    final OperatingSystem os = contexts.getOperatingSystem();
    os.setRooted(null);

    contexts.setDevice(device);
    contexts.setOperatingSystem(os);
    event.getContexts().putAll(contexts);
    event.setUser(null);
    event.removeTag("os.rooted");
    event.removeTag("user");
    return event;
  }
}
