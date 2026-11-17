package com.nissenhooper.throughhoops

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null

  // Android 17 (API 37) blocks LAN traffic for apps targeting 37 unless this
  // runtime permission is granted. Without it, WebRTC host candidates and
  // iroh's mDNS/direct LAN paths fail, so same-Wi-Fi calls never connect.
  private val localNetworkPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      Log.i(TAG, "ACCESS_LOCAL_NETWORK granted=$granted")
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicastLock = wifiManager.createMulticastLock("through-hoops-mdns").apply {
      setReferenceCounted(true)
      acquire()
    }
    super.onCreate(savedInstanceState)
    requestLocalNetworkPermission()
  }

  private fun requestLocalNetworkPermission() {
    if (Build.VERSION.SDK_INT < 37) return
    val permission = Manifest.permission.ACCESS_LOCAL_NETWORK
    if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
      localNetworkPermission.launch(permission)
    }
  }

  override fun onDestroy() {
    multicastLock?.release()
    multicastLock = null
    super.onDestroy()
  }

  private companion object {
    const val TAG = "through-hoops"
  }
}
