# Consumer ProGuard/R8 rules for OutlineAndroidLib.
#
# These rules are packaged into the library's AAR and applied to the R8 run of
# any module that consumes it -- most importantly the Capacitor app module
# (client/capacitor/android/app), which shrinks with R8. They keep every type
# that R8 cannot see is reachable because it is instantiated reflectively,
# bound over JNI, referenced from the manifest, or crosses the AIDL boundary.
# (The Capacitor plugin classes are kept by capacitor-android's own consumer
# rules.)
#
# When adding code that is only reachable via one of those mechanisms, add a
# keep rule here.

# --- gomobile / tun2socks (JNI) --------------------------------------------
# The gomobile-generated bindings and the Go runtime call back into these
# classes by name over JNI; obfuscating or removing them breaks the tunnel.
-keep class tun2socks.** { *; }
-keep class go.** { *; }

# Keep every native method and the class that declares it.
-keepclasseswithmembernames class * {
  native <methods>;
}

# --- AIDL / Parcelable boundary --------------------------------------------
# The VPN service runs in a separate (:vpn) process and communicates over AIDL.
# Keep the generated interface (Stub/Proxy) and the Parcelable data classes,
# including their CREATOR fields.
-keep class org.outline.IVpnTunnelService { *; }
-keep class org.outline.IVpnTunnelService$* { *; }
-keep class org.outline.TunnelConfig { *; }
-keep class org.outline.DetailedJsonError { *; }

-keepclassmembers class * implements android.os.Parcelable {
  public static final android.os.Parcelable$Creator CREATOR;
}

# --- Manifest-declared components ------------------------------------------
# AGP already generates keep rules for classes named in the merged manifest,
# but keep them explicitly so the contract is visible and robust to manifest
# processing changes. These are the VPN service (bound by the system and by
# the plugin), its boot/replace receiver, and the Quick Settings tile.
-keep class org.outline.vpn.VpnTunnelService { *; }
-keep class org.outline.vpn.VpnServiceStarter { *; }
-keep class org.outline.vpn.QuickSettingsTileService { *; }

# --- Runtime-derived names -------------------------------------------------
# VpnTunnelStore derives its SharedPreferences filename from its own class name
# (VpnTunnelStore.class.getName()). This must hold in the *app* R8 pass too
# (now that the app module minifies): obfuscating the name would point the app,
# boot receiver, and Quick Settings tile at a different store and lose the
# user's persisted tunnel state across an update. (The library's own R8 pass is
# covered by proguard-rules.pro; this consumer rule covers the app's pass.)
-keepnames class org.outline.vpn.VpnTunnelStore
