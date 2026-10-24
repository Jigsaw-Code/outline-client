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

import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Collection;
import java.util.Queue;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.logging.LogManager;
import org.apache.commons.collections4.queue.CircularFifoQueue;

/**
 * Static class to customize logging for Outline's needs through default Java logging facilities.
 *
 * All classes in this package should use the Android logging class
 * (android.util.Log) in order to avoid circular dependencies.
 */
public class OutlineLogger {
  private static final String LOG_TAG = OutlineLogger.class.getName();

  // Disallow instantiation in favor of a purely static class.
  private OutlineLogger() {}

  private static Logger rootLogger = LogManager.getLogManager().getLogger("");
  static {
    try {
      rootLogger.setLevel(Level.FINER);
    } catch (Exception e) {
      Log.e(LOG_TAG, "Failed to configure root logger", e);
    }
  }

  /**
   * Adds a custom log handler to the Java root logger.
   *
   * @param handler log handler
   */
  public static void registerLogHandler(Handler handler) {
    rootLogger.addHandler(handler);
  }

  /**
   * Retrieves the most recent VPN service process logs from logcat and returns them in ascending
   * order by timestamp.
   *
   * @param maxNumLogs the maximum number of logs to return.
   * @return a collection with each VPN process log entry or an empty collection on failure.
   */
  public static Collection<String> getVpnProcessLogs(int maxNumLogs) {
    // Retrieve the logs by filtering known VPN process tags at INFO level.
    final String LOGCAT_CMD =
        "logcat -d -s VpnTunnel:I VpnTunnelService:I VpnTunnelStore:I tun2socks:I";
    // Use an FIFO evicting queue to hold the most recent `maxNumLogs` logs.
    Queue<String> logs = new CircularFifoQueue<>(maxNumLogs);
    try {
      Process process = Runtime.getRuntime().exec(LOGCAT_CMD);
      BufferedReader bufferedReader =
          new BufferedReader(new InputStreamReader(process.getInputStream()));

      String log;
      while ((log = bufferedReader.readLine()) != null) {
        logs.add(log);
      }
    } catch (Exception e) {
      Log.e(LOG_TAG, "Failed to retrieve VPN process logs", e);
    }
    return logs;
  }

  /**
   * Returns the short logger tag (up to 23 chars) for the given logger name.
   * Traditionally loggers are named by fully-qualified Java classes; this
   * method attempts to return a concise identifying part of such names.
   *
   * Source: https://android.googlesource.com/platform/libcore-snapshot/+/ics-mr1/dalvik/src/main/java/dalvik/system/DalvikLogging.java
   */
  static String loggerNameToTag(String loggerName) {
    // Anonymous logger.
    if (loggerName == null) {
      return "null";
    }
    int length = loggerName.length();
    if (length <= 23) {
      return loggerName;
    }
    int lastPeriod = loggerName.lastIndexOf(".");
    return length - (lastPeriod + 1) <= 23
        ? loggerName.substring(lastPeriod + 1)
        : loggerName.substring(loggerName.length() - 23);
  }
}
