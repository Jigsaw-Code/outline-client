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

package org.outline

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.net.VpnService
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONException
import org.outline.log.OutlineLogger
import org.outline.log.SentryErrorReporter
import org.outline.vpn.Errors
import org.outline.vpn.QuickSettingsTileService
import org.outline.vpn.VpnServiceStarter
import org.outline.vpn.VpnTunnelService
import org.outline.vpn.VpnTunnelStore
import outline.Outline
import platerrors.Platerrors
import platerrors.PlatformError

@CapacitorPlugin(name = "CapacitorPluginOutline")
class CapacitorPluginOutline : Plugin() {

  private data class StartVpnRequest(
      val args: StartArgs,
      val call: PluginCall,
  )

  private data class StartArgs(
      val tunnelId: String,
      val serverName: String,
      val transportConfig: String,
  )

  // All fields below are read from both the main thread (ServiceConnection /
  // activity-result callbacks) and the executor pool (@PluginMethod handlers),
  // so every access must go through `stateLock` to guarantee both visibility
  // and atomicity of check-then-act sequences.
  private val stateLock = Any()
  private var vpnTunnelService: IVpnTunnelService? = null
  private var errorReportingApiKey: String? = null
  private var pendingVpnPermissionRequest: StartVpnRequest? = null
  private var pendingServiceBindRequest: StartVpnRequest? = null
  private val executor = Executors.newCachedThreadPool()

  private val vpnServiceConnection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, service: IBinder) {
      val pending: StartVpnRequest?
      synchronized(stateLock) {
        vpnTunnelService = IVpnTunnelService.Stub.asInterface(service)
        pending = pendingServiceBindRequest
        pendingServiceBindRequest = null
      }
      if (pending != null) {
        executeStartTunnel(pending.call, pending.args)
      }
    }

    override fun onServiceDisconnected(name: ComponentName) {
      val apiKey = synchronized(stateLock) {
        vpnTunnelService = null
        errorReportingApiKey
      }
      val context = baseContext()
      val rebind = Intent(context, VpnTunnelService::class.java).apply {
        putExtra(VpnServiceStarter.AUTOSTART_EXTRA, true)
        putExtra(
            VpnTunnelService.MessageData.ERROR_REPORTING_API_KEY.value,
            apiKey,
        )
      }
      context.bindService(rebind, this, Context.BIND_AUTO_CREATE)
    }
  }

  private val vpnTunnelBroadcastReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val tunnelId = intent.getStringExtra(VpnTunnelService.MessageData.TUNNEL_ID.value) ?: return
      val status = intent.getIntExtra(
          VpnTunnelService.MessageData.PAYLOAD.value,
          VpnTunnelService.TunnelStatus.INVALID.value,
      )
      val payload = JSObject().apply {
        put("id", tunnelId)
        put("status", status)
      }
      notifyListeners(STATUS_CHANGE_EVENT, payload)
    }
  }

  override fun load() {
    super.load()
    val context = baseContext()

    OutlineLogger.registerLogHandler(SentryErrorReporter.BREADCRUMB_LOG_HANDLER)

    val goConfig = Outline.getBackendConfig()
    goConfig.dataDir = context.filesDir.absolutePath

    val broadcastFilter = IntentFilter().apply {
      addAction(VpnTunnelService.STATUS_BROADCAST_KEY)
      addCategory(context.packageName)
    }
    context.registerReceiver(
        vpnTunnelBroadcastReceiver,
        broadcastFilter,
        Context.RECEIVER_NOT_EXPORTED,
    )

    context.bindService(
        Intent(context, VpnTunnelService::class.java),
        vpnServiceConnection,
        Context.BIND_AUTO_CREATE,
    )
  }

  override fun handleOnDestroy() {
    val context = baseContext()
    try {
      context.unregisterReceiver(vpnTunnelBroadcastReceiver)
    } catch (ignored: IllegalArgumentException) { }
    kotlin.runCatching { context.unbindService(vpnServiceConnection) }
    executor.shutdown()
    super.handleOnDestroy()
  }

  @PluginMethod
  fun invokeMethod(call: PluginCall) {
    executor.execute {
      try {
        val methodName = call.getString("method")
        if (methodName.isNullOrEmpty()) {
          call.reject("Missing Outline method name.")
          return@execute
        }
        val input = call.getString("input", "") ?: ""
        // Forgetting a server erases Go per-service files but previously left the
        // Java VpnTunnelStore intact, so the Quick Settings tile could reconnect
        // to a removed server. Clear the store when the forgotten id matches.
        if (methodName == METHOD_ERASE_SERVICE_STORAGE) {
          clearTunnelStoreIfMatches(input)
        }
        val result = Outline.invokeMethod(methodName, input)
        result.error?.let { error ->
          sendErrorResult(call, error)
          return@execute
        }
        call.resolve(JSObject().apply { put("value", result.value) })
      } catch (e: Exception) {
        sendErrorResult(call, platformErrorFromException(e))
      }
    }
  }

  @PluginMethod
  fun start(call: PluginCall) {
    val tunnelId = call.getString("tunnelId")
    val serverName = call.getString("serverName")
    val transportConfig = call.getString("transportConfig")

    if (tunnelId.isNullOrEmpty() || transportConfig.isNullOrEmpty() || serverName.isNullOrEmpty()) {
      call.reject("Missing tunnel start parameters.")
      return
    }

    val startArgs = StartArgs(tunnelId, serverName, transportConfig)

    if (!prepareVpnService(call, startArgs)) {
      return
    }

    executeStartTunnel(call, startArgs)
  }

  @PluginMethod
  fun stop(call: PluginCall) {
    executor.execute {
      try {
        val tunnelId = call.getString("tunnelId")
        if (tunnelId.isNullOrEmpty()) {
          call.reject("Missing tunnelId.")
          return@execute
        }
        val service = synchronized(stateLock) { vpnTunnelService }
        if (service == null) {
          sendErrorResult(call, vpnServiceUnavailableError())
          return@execute
        }
        val result = service.stopTunnel(tunnelId)
        if (result == null) call.resolve() else call.reject(result.errorJson)
      } catch (e: Exception) {
        sendErrorResult(call, platformErrorFromException(e))
      }
    }
  }

  @PluginMethod
  fun isRunning(call: PluginCall) {
    executor.execute {
      try {
        val tunnelId = call.getString("tunnelId")
        if (tunnelId.isNullOrEmpty()) {
          call.reject("Missing tunnelId.")
          return@execute
        }
        val service = synchronized(stateLock) { vpnTunnelService }
        val isActive = try {
          service?.isTunnelActive(tunnelId) ?: false
        } catch (e: Exception) {
          false
        }
        call.resolve(JSObject().apply { put("isRunning", isActive) })
      } catch (e: Exception) {
        sendErrorResult(call, platformErrorFromException(e))
      }
    }
  }

  @PluginMethod
  fun initializeErrorReporting(call: PluginCall) {
    executor.execute {
      try {
        val apiKey = call.getString("apiKey")
        if (apiKey.isNullOrEmpty()) {
          call.reject("Missing error reporting API key.")
          return@execute
        }
        val service = synchronized(stateLock) {
          errorReportingApiKey = apiKey
          vpnTunnelService
        }
        SentryErrorReporter.init(baseContext(), apiKey)
        service?.initErrorReporting(apiKey)
        call.resolve()
      } catch (e: Exception) {
        sendErrorResult(call, platformErrorFromException(e))
      }
    }
  }

  @PluginMethod
  fun reportEvents(call: PluginCall) {
    executor.execute {
      try {
        val uuid = call.getString("uuid")
        if (uuid.isNullOrEmpty()) {
          call.reject("Missing report UUID.")
          return@execute
        }
        SentryErrorReporter.send(uuid)
        call.resolve()
      } catch (e: Exception) {
        sendErrorResult(call, platformErrorFromException(e))
      }
    }
  }

  /**
   * Reads the localStorage the Cordova build wrote under the file:// origin.
   *
   * The Cordova app ran from file:///android_asset/www/ (config.xml sets
   * AndroidInsecureFileModeEnabled), while Capacitor serves https://localhost.
   * Chromium partitions storage by origin, so the servers and settings written
   * by the Cordova build are invisible to the Capacitor WebView. Loading any
   * file:// document off-screen gives us a context that can read them, which we
   * then hand back to the web layer to replay into the new origin.
   *
   * Resolves with the legacy key/value pairs. An empty object is a perfectly good
   * result — it means the origin was read and held nothing — so the caller should
   * treat it as a completed migration rather than retrying.
   *
   * Rejects when the read could not be performed at all: no activity, the bridge
   * page failed to load, the dump script threw, or the timeout fired. Nothing is
   * known about the legacy origin in that case, so the caller should try again on
   * a later launch. See the LEGACY_STORAGE_* codes for which one occurred.
   *
   * It always completes, one way or the other: the web layer awaits this during
   * startup, so an outstanding call would mean an app that never launches.
   */
  @PluginMethod
  fun getLegacyCordovaLocalStorage(call: PluginCall) {
    val currentActivity = activity ?: run {
      call.reject("No active activity to read legacy storage.", ERROR_NO_ACTIVITY)
      return
    }

    currentActivity.runOnUiThread {
      val handler = Handler(Looper.getMainLooper())
      val settled = AtomicBoolean(false)
      var webView: WebView? = null

      // Completes the call exactly once, whichever of load / error / timeout wins
      // the race, and disposes of the WebView. Only ever called on the UI thread.
      fun settle(complete: () -> Unit) {
        if (!settled.compareAndSet(false, true)) return
        handler.removeCallbacksAndMessages(null)
        val doomed = webView
        webView = null
        complete()
        // Tearing a WebView down from inside its own evaluateJavascript callback
        // crashes on some WebView builds, so destroy it on a later loop turn.
        handler.post { doomed?.destroy() }
      }

      // Success carries the legacy pairs, which may legitimately be empty.
      fun succeed(storage: JSObject) = settle { call.resolve(storage) }
      // Failure means nothing is known about the legacy origin. The code lets the
      // caller tell a cheap failure from a timeout without another native change.
      fun fail(message: String, code: String) = settle { call.reject(message, code) }

      try {
        webView = WebView(currentActivity).apply {
          // Only these two are load bearing: the injected script needs JavaScript,
          // and localStorage needs DOM storage. Deliberately NOT setting
          // allowFileAccess or allowUniversalAccessFromFileURLs, which
          // cordova-android turns on under AndroidInsecureFileModeEnabled:
          // the first governs file *system* access and is not required to reach
          // file:///android_asset, and the second only permits cross-origin
          // access from a file:// document, which this inert page never makes.
          // Both are deprecated and widen the attack surface for no benefit here.
          settings.javaScriptEnabled = true
          settings.domStorageEnabled = true

          webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
              // loadUrl is asynchronous: the document only has a file:// origin
              // (and localStorage) once it has finished loading.
              view.evaluateJavascript(DUMP_LOCAL_STORAGE_JS) { result ->
                val storage = decodeLocalStorage(result)
                if (storage == null) {
                  fail("Could not read the legacy local storage.", ERROR_UNREADABLE)
                } else {
                  succeed(storage)
                }
              }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
              if (request.isForMainFrame) {
                fail(
                    "Could not load the legacy storage bridge page: ${error.description}",
                    ERROR_LOAD_FAILED,
                )
              }
            }
          }
        }

        webView?.loadUrl(LEGACY_STORAGE_BRIDGE_URL)
        // The web layer awaits this during startup, so the call must always be
        // completed — a silent hang here would be an app that never launches.
        handler.postDelayed(
            { fail("Timed out reading the legacy local storage.", ERROR_TIMEOUT) },
            LEGACY_STORAGE_TIMEOUT_MS,
        )
      } catch (e: Exception) {
        fail("Could not open a WebView on the legacy origin: ${e.message}", ERROR_UNAVAILABLE)
      }
    }
  }

  @PluginMethod
  fun quitApplication(call: PluginCall) {
    val currentActivity = activity ?: run {
      call.reject("No active activity to close")
      return
    }

    currentActivity.finishAffinity()
    currentActivity.finishAndRemoveTask()

    android.os.Process.killProcess(android.os.Process.myPid())
    call.resolve()
  }

  /**
   * Receives the result of the system VPN permission dialog launched by
   * [prepareVpnService]. Capacitor finds this method by name, through the
   * launcher it registers for every [ActivityCallback] method.
   *
   * The start request is taken from [pendingVpnPermissionRequest] rather than
   * from [savedCall]. The two hold the same call, except when the activity was
   * recreated underneath the dialog: Capacitor then passes a call rebuilt from
   * saved state (or null) to a new plugin instance, which has no pending request
   * and no web callback left to answer, so there is nothing to resume.
   */
  @ActivityCallback
  @Suppress("unused", "UNUSED_PARAMETER")
  private fun onVpnPermissionResult(savedCall: PluginCall?, result: ActivityResult) {
    val startRequest = synchronized(stateLock) {
      val req = pendingVpnPermissionRequest
      pendingVpnPermissionRequest = null
      req
    } ?: return
    val call = startRequest.call

    if (result.resultCode != Activity.RESULT_OK) {
      sendErrorResult(call, vpnPermissionDeniedError())
      bridge.releaseCall(call)
      return
    }

    executeStartTunnel(call, startRequest.args)
  }

  private sealed class StartDecision {
    data class Dispatch(val service: IVpnTunnelService) : StartDecision()
    object Queued : StartDecision()
    object AlreadyPending : StartDecision()
  }

  private fun executeStartTunnel(call: PluginCall, args: StartArgs) {
    val decision = synchronized(stateLock) {
      val current = vpnTunnelService
      when {
        current != null -> StartDecision.Dispatch(current)
        pendingServiceBindRequest != null -> StartDecision.AlreadyPending
        else -> {
          pendingServiceBindRequest = StartVpnRequest(args, call)
          StartDecision.Queued
        }
      }
    }

    when (decision) {
      StartDecision.AlreadyPending -> {
        sendErrorResult(call, startAlreadyInProgressError())
        // Release the saved-call slot if this call was saved earlier by
        // prepareVpnService before onVpnPermissionResult re-entered here.
        // No-op for an unsaved call.
        bridge.releaseCall(call)
      }
      StartDecision.Queued -> {
        call.setKeepAlive(true)
        saveCall(call)
      }
      is StartDecision.Dispatch -> executor.execute {
        try {
          val config = TunnelConfig().apply {
            id = args.tunnelId
            name = args.serverName
            transportConfig = args.transportConfig
          }
          val result = decision.service.startTunnel(config)
          if (result == null) call.resolve() else call.reject(result.errorJson)
        } catch (e: Exception) {
          sendErrorResult(call, platformErrorFromException(e))
        } finally {
          // Release the saved-call slot held when this call was queued
          // (via prepareVpnService or the Queued branch above). For an
          // unsaved call, releaseCall is a no-op.
          bridge.releaseCall(call)
        }
      }
    }
  }

  private fun prepareVpnService(call: PluginCall, args: StartArgs): Boolean {
    val prepareIntent = VpnService.prepare(baseContext())
    if (prepareIntent == null) return true

    if (activity == null) {
      call.reject("Unable to request VPN permission without an active activity.")
      return false
    }

    val alreadyPending = synchronized(stateLock) {
      if (pendingVpnPermissionRequest != null) {
        true
      } else {
        pendingVpnPermissionRequest = StartVpnRequest(args, call)
        false
      }
    }
    if (alreadyPending) {
      sendErrorResult(call, startAlreadyInProgressError())
      return false
    }

    try {
      // Saves the call until onVpnPermissionResult runs. This has to go through
      // Capacitor's launcher: the bridge only routes a raw
      // Activity.startActivityForResult result to a plugin that declares the
      // request code in the legacy `requestCodes` annotation field.
      startActivityForResult(call, prepareIntent, VPN_PERMISSION_CALLBACK)
    } catch (e: Exception) {
      // For example, a device with no system VPN dialog to show. Letting this
      // escape a plugin method would crash the app.
      synchronized(stateLock) { pendingVpnPermissionRequest = null }
      bridge.releaseCall(call)
      sendErrorResult(call, platformErrorFromException(e))
    }
    return false
  }

  private fun sendErrorResult(call: PluginCall, error: PlatformError) {
    val detailedError = Errors.toDetailedJsonError(error)
    if (detailedError == null) {
      call.reject("Unknown Outline error")
    } else {
      call.reject(detailedError.errorJson, detailedError.code)
    }
  }

  /**
   * Clears [VpnTunnelStore] when [serviceId] matches the persisted tunnel id.
   * Do not clear on disconnect — that would break boot / always-on auto-start.
   */
  private fun clearTunnelStoreIfMatches(serviceId: String) {
    if (serviceId.isEmpty()) return
    try {
      val store = VpnTunnelStore(baseContext())
      val stored = store.load() ?: return
      if (serviceId == stored.optString("id")) {
        store.clear()
        QuickSettingsTileService.requestTileUpdate(baseContext())
      }
    } catch (e: Exception) {
      // Erase must still reach Go even if the Java store clear fails.
    }
  }

  private fun baseContext(): Context = context.applicationContext

  companion object {
    // Must match the name of the @ActivityCallback method.
    private const val VPN_PERMISSION_CALLBACK = "onVpnPermissionResult"
    private const val STATUS_CHANGE_EVENT = "onStatusChange"
    // Must match outline.MethodEraseServiceStorage in the Go method channel.
    private const val METHOD_ERASE_SERVICE_STORAGE = "EraseServiceStorage"

    // Any file:// document shares the single file:// storage origin, so this
    // reads the same namespace the Cordova build wrote to under www/.
    private const val LEGACY_STORAGE_BRIDGE_URL =
        "file:///android_asset/public/migrate.html"
    private const val LEGACY_STORAGE_TIMEOUT_MS = 5_000L

    // Rejection codes. Every one of these means the legacy origin could not be
    // read, so nothing is known about it and the caller should try again later.
    // They are distinguished so the caller can treat the one slow failure
    // (a timeout) differently from the ones that return in milliseconds.
    private const val ERROR_NO_ACTIVITY = "LEGACY_STORAGE_NO_ACTIVITY"
    private const val ERROR_UNAVAILABLE = "LEGACY_STORAGE_UNAVAILABLE"
    private const val ERROR_LOAD_FAILED = "LEGACY_STORAGE_LOAD_FAILED"
    private const val ERROR_UNREADABLE = "LEGACY_STORAGE_UNREADABLE"
    private const val ERROR_TIMEOUT = "LEGACY_STORAGE_TIMEOUT"

    // Injected rather than defined in migrate.html, so the page stays inert and
    // the two halves of this can never drift out of sync.
    //
    // Returns the object itself, not a JSON string: evaluateJavascript already
    // hands the result back as JSON text, so stringifying here would encode it
    // twice and force the caller to unwrap two layers.
    private const val DUMP_LOCAL_STORAGE_JS = """
      (function () {
        try {
          var dump = {};
          for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            dump[key] = localStorage.getItem(key);
          }
          return dump;
        } catch (e) {
          return null;
        }
      })();
    """
  }
}

/**
 * Parses the JSON text [WebView.evaluateJavascript] hands back into an object.
 *
 * The WebView bridge is textual, so this is the one place the dump has to be
 * deserialized. Doing it here means the plugin result carries a real key/value
 * object and no layer above has to know it was ever serialized.
 *
 * Returns null when the script reported failure (`null`) or produced something
 * that is not a JSON object.
 */
private fun decodeLocalStorage(result: String?): JSObject? {
  if (result.isNullOrEmpty() || result == "null") return null
  return try {
    JSObject(result)
  } catch (e: JSONException) {
    null
  }
}

private fun platformErrorFromException(e: Exception): PlatformError =
    PlatformError(Platerrors.InternalError, e.message ?: e.toString())

private fun vpnPermissionDeniedError(): PlatformError =
    PlatformError(Platerrors.VPNPermissionNotGranted, "VPN permission not granted")

private fun vpnServiceUnavailableError(): PlatformError =
    PlatformError(Platerrors.InternalError, "VPN tunnel service is not bound")

private fun startAlreadyInProgressError(): PlatformError =
    PlatformError(Platerrors.InternalError, "A VPN start request is already in progress")
