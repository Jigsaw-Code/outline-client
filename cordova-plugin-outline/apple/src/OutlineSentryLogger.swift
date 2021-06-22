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

import CocoaLumberjack
import CocoaLumberjackSwift
import Sentry

// Custom CocoaLumberjack logger that logs messages to Sentry.
@objc
class OutlineSentryLogger: DDAbstractLogger {

  static let sharedInstance = OutlineSentryLogger()

#if os(macOS)
  private static let kAppGroup = "QT8Z3Q9V3A.org.outline.macos.client"
#else
  private static let kAppGroup = "group.org.outline.ios.client"
#endif
  private static let kDateFormat = "yyyy/MM/dd HH:mm:ss:SSS"
  private static let kDatePattern = "[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}:[0-9]{3}"

  private var breadcrumbQueue = [Breadcrumb]()
  private var logsDirectory: String!

  // Initializes CocoaLumberjack, adding itself as a logger.
  func initializeLogging() {
    guard let containerUrl = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: OutlineSentryLogger.kAppGroup) else {
      DDLogError("Failed to retrieve app container directory")
      return
    }
    self.logsDirectory = containerUrl.appendingPathComponent("Logs").path

    DDLog.add(OutlineSentryLogger.sharedInstance)
    #if os(iOS)
      DDLog.add(DDOSLogger.sharedInstance)
    #else
      if #available(OSX 10.12, *) {
        DDLog.add(DDOSLogger.sharedInstance)
      } else {
        // Fallback on earlier versions
        DDLog.add(DDASLLogger.sharedInstance)
      }
    #endif
    dynamicLogLevel = DDLogLevel.info
  }

  // Adds |logMessage| to Sentry as a breadcrumb.
  override func log(message logMessage: DDLogMessage) {
    let breadcrumb = Breadcrumb(level: ddLogLevelToSentryLevel(logMessage.level), category:"App")
    breadcrumb.message = logMessage.message
    breadcrumb.timestamp = logMessage.timestamp
    if OutlineSentryLogger.isSentryInitialized() {
      if !self.breadcrumbQueue.isEmpty {
        self.drainBreadcrumbQueue()
      }
      SentrySDK.addBreadcrumb(crumb: breadcrumb)
    } else {
      // Sentry has not been initialized yet. Add breadcrumb to queue.
      self.breadcrumbQueue.append(breadcrumb)
    }
  }

  static func isSentryInitialized() -> Bool {
    return SentrySDK.currentHub().getClient() != nil;
  }

  private func ddLogLevelToSentryLevel(_ level: DDLogLevel) -> SentryLevel {
    switch level {
    case .error:
      return .error
    case .warning:
      return .warning
    case .info:
      return .info
    default:
      return .debug
    }
  }

  private func drainBreadcrumbQueue() {
    for breadcrumb in self.breadcrumbQueue {
      SentrySDK.addBreadcrumb(crumb: breadcrumb)
    }
    self.breadcrumbQueue.removeAll()
  }

  // Reads VpnExtension logs and adds them to Sentry as breadcrumbs.
  func addVpnExtensionLogsToSentry() {
    if !OutlineSentryLogger.isSentryInitialized() {
      DDLogWarn("Sentry client not initialized.")
      return
    }
    var logs: [String]
    do {
      logs = try FileManager.default.contentsOfDirectory(atPath: self.logsDirectory)
    } catch {
      DDLogError("Failed to list logs directory. Not sending VPN logs")
      return
    }

    let dateFormatter = DateFormatter()
    dateFormatter.dateFormat = OutlineSentryLogger.kDateFormat
    // Breadcrumbs come from the application and VpnExtension processes. There is a limit to how
    // many we send, definied in OutlinePlugin.kMaxBreadcrumbs.
    // Set the number of breadcrumbs for the VPN process to half of the maximum breadcrumbs.
    let maxNumVpnExtensionBreadcrumbs = OutlinePlugin.kMaxBreadcrumbs / 2
    var numBreadcrumbsAdded: UInt = 0
    // Log files are named by date, get the most recent.
    for logFile in logs.sorted().reversed() {
      let logFilePath = (self.logsDirectory as NSString).appendingPathComponent(logFile)
      DDLogDebug("Reading log file: \(String(describing: logFilePath))")
      do {
        let logContents = try String(contentsOf: NSURL.fileURL(withPath: logFilePath))
        // Order log lines descending by time.
        let logLines = logContents.components(separatedBy: "\n").reversed()
        for line in logLines {
          if numBreadcrumbsAdded >= maxNumVpnExtensionBreadcrumbs {
            return
          }
          if let (timestamp, message) = parseTimestamp(in: line) {
            let breadcrumb = Breadcrumb(level: .info, category: "VpnExtension")
            breadcrumb.timestamp = dateFormatter.date(from: timestamp)
            breadcrumb.message = message
            SentrySDK.addBreadcrumb(crumb: breadcrumb)
            numBreadcrumbsAdded += 1
          }
        }
      } catch let error {
        DDLogError("Failed to read logs: \(error)")
      }
    }
  }

  private func parseTimestamp(in log:String) -> (String, String)? {
    do {
      let regex = try NSRegularExpression(pattern: OutlineSentryLogger.kDatePattern)
      let logNsString = log as NSString // Cast to access NSString length and substring methods.
      let results = regex.matches(in: log, range: NSRange(location: 0, length: logNsString.length))
      if !results.isEmpty {
        let timestamp = logNsString.substring(with: results[0].range)
        let message = logNsString.substring(from: timestamp.count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (timestamp, message)
      }
    } catch let error {
      DDLogError("Failed to parse timestamp: \(error)")
    }
    return nil
  }
}
