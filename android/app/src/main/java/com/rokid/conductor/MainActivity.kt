package com.rokid.conductor

import android.Manifest
import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.rokid.conductor.bridge.GlassesBridge

/**
 * Single-activity WebView shell. The entire UI (login, projects, tasks, chat, realtime) is the
 * existing Conductor web frontend, loaded here as a web page — so there is only one frontend
 * codebase to maintain. Native code is limited to the glasses + speech bridge
 * ([GlassesBridge]), exposed to the page as `window.RokidGlassesNative`.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: GlassesBridge
    private val prefs by lazy { getSharedPreferences("conductor_shell", MODE_PRIVATE) }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {}

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestRuntimePermissions()
        enableEdgeToEdge()

        // Allow chrome://inspect remote debugging for debuggable (dev) builds only.
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            webViewClient = object : WebViewClient() {
                // Remember the last real page so a relaunch after the OS reclaims the process
                // returns there instead of the home/start URL.
                override fun onPageFinished(view: WebView?, url: String?) {
                    if (url != null && url.startsWith("http")) {
                        prefs.edit().putString(KEY_LAST_URL, url).apply()
                    }
                }
            }
            webChromeClient = object : WebChromeClient() {
                // Grant the page mic access; OS-level RECORD_AUDIO is requested separately.
                override fun onPermissionRequest(request: PermissionRequest) {
                    val wanted = request.resources
                        .filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                        .toTypedArray()
                    if (wanted.isNotEmpty()) request.grant(wanted) else request.deny()
                }
            }
        }

        bridge = GlassesBridge(applicationContext, webView)
        webView.addJavascriptInterface(bridge, "RokidGlassesNative")

        // Host the WebView in a container and pad the CONTAINER by the system bars, so the page
        // never sits under the status bar (top) / nav bar (bottom). Padding a WebView directly is
        // unreliable; padding the parent container offsets the WebView dependably.
        val container = FrameLayout(this).apply {
            setBackgroundColor(0xFFF5F1EA.toInt()) // web --paper, so the status-bar strip blends in
            addView(
                webView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            v.updatePadding(top = bars.top, bottom = bars.bottom, left = bars.left, right = bars.right)
            insets
        }
        ViewCompat.requestApplyInsets(container)

        // Restore the previous page/history when the activity is recreated (e.g. the OS killed the
        // backgrounded process); only load the start URL on a genuinely fresh launch.
        val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
        if (!restored) webView.loadUrl(resolveStartUrl())

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    /**
     * Start URL. An explicit intent `start_url` (dev) wins; otherwise resume the last visited
     * page (so re-entering after the OS reclaimed the process lands where the user left off);
     * falling back to the default home URL on a first-ever launch.
     */
    private fun resolveStartUrl(): String =
        intent?.getStringExtra(EXTRA_START_URL)?.takeIf { it.isNotBlank() }
            ?: prefs.getString(KEY_LAST_URL, null)?.takeIf { it.isNotBlank() }
            ?: DEFAULT_URL

    private fun requestRuntimePermissions() {
        val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms += Manifest.permission.BLUETOOTH_CONNECT
            perms += Manifest.permission.BLUETOOTH_SCAN
        } else {
            perms += Manifest.permission.ACCESS_FINE_LOCATION
        }
        permissionLauncher.launch(perms.toTypedArray())
    }

    override fun onDestroy() {
        bridge.release()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_START_URL = "start_url"
        private const val DEFAULT_URL = "https://conductor-ai.top"
        private const val KEY_LAST_URL = "last_url"
    }
}
