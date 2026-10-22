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
public class OutlineSentryLogger: DDAbstractLogger {
    private static let kDateFormat = "yyyy/MM/dd HH:mm:ss:SSS"
    private static let kDatePattern = "[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}:[0-9]{3}"

    private var logsDirectory: String?

    // Initializes CocoaLumberjack, adding itself as a logger.
    public init(forAppGroup appGroup: String) {
      super.init()
      guard let containerUrl = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup) else {
        DDLogError("Failed to retrieve app container directory")
        return
      }
      self.logsDirectory = containerUrl.appendingPathComponent("Logs").path

      DDLog.add(self)
      DDLog.add(DDOSLogger.sharedInstance)
#if DEBUG
      dynamicLogLevel = DDLogLevel.all
#else
      dynamicLogLevel = DDLogLevel.info
#endif
    }

    // Adds |logMessage| to Sentry as a breadcrumb.
    public override func log(message logMessage: DDLogMessage) {
        let breadcrumb = Breadcrumb(level: ddLogLevelToSentryLevel(logMessage.level), category:"App")
        breadcrumb.message = logMessage.message
        breadcrumb.timestamp = logMessage.timestamp
        SentrySDK.addBreadcrumb(breadcrumb)
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
    
    // Reads VpnExtension logs and adds them to Sentry as breadcrumbs.
    public func addVpnExtensionLogsToSentry(maxBreadcrumbsToAdd: Int) {
        guard let logsDirectory = self.logsDirectory else {
            DDLogError("Logs directory unavailable. Not sending VPN logs")
            return
        }
        var logs: [String]
        do {
            logs = try FileManager.default.contentsOfDirectory(atPath: logsDirectory)
        } catch {
            DDLogError("Failed to list logs directory. Not sending VPN logs")
            return
        }
        
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = OutlineSentryLogger.kDateFormat
        var numBreadcrumbsAdded: UInt = 0
        // Log files are named by date, get the most recent.
        for logFile in logs.sorted().reversed() {
            let logFilePath = (logsDirectory as NSString).appendingPathComponent(logFile)
            DDLogDebug("Reading log file: \(String(describing: logFilePath))")
            do {
                let logContents = try String(contentsOf: NSURL.fileURL(withPath: logFilePath))
                // Order log lines descending by time.
                let logLines = logContents.components(separatedBy: "\n").reversed()
                for line in logLines {
                    if numBreadcrumbsAdded >= maxBreadcrumbsToAdd {
                        return
                    }
                    if let (timestamp, message) = parseTimestamp(in: line) {
                        let breadcrumb = Breadcrumb(level: .info, category: "VpnExtension")
                        breadcrumb.timestamp = dateFormatter.date(from: timestamp)
                        breadcrumb.message = message
                        SentrySDK.addBreadcrumb(breadcrumb)
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
