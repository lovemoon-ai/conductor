package com.rokid.conductor.glasses

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.rokid.cxr.client.extend.CxrApi
import com.rokid.cxr.client.extend.callbacks.BluetoothStatusCallback
import com.rokid.cxr.client.extend.listeners.AiEventListener
import com.rokid.cxr.client.extend.listeners.AudioStreamListener
import com.rokid.cxr.client.extend.listeners.CustomCmdListener
import com.rokid.cxr.client.extend.listeners.CustomViewListener
import com.rokid.cxr.Caps
import com.rokid.cxr.client.utils.ValueUtil
import org.json.JSONArray
import org.json.JSONObject

/** A bonded Bluetooth device the user can connect to. */
data class GlassDevice(val name: String, val mac: String)

interface GlassesListener {
    fun onStatus(connected: Boolean, text: String)
    /** Glasses AI button pressed (push-to-talk start). */
    fun onAiKeyDown()
    /** Glasses AI button released (push-to-talk stop). */
    fun onAiKeyUp()
    /** User exited the AI scene on the glasses. */
    fun onAiExit()
}

/**
 * Wraps the Rokid CXR-M [CxrApi] for the "phone as controller, glasses as display" model.
 *
 * Connection flow mirrors the proven RokidGlassesReader reference (CXR-M `client-m` 1.0.1):
 *   1. deinitBluetooth() to clear any stale SDK state
 *   2. short delay (longer if the device is already system-connected), then initBluetooth(device)
 *   3. on onConnectionInfo(uuid, mac) -> connectBluetooth(ctx, uuid, mac, cb)   [4-arg, no SN check]
 *   4. connectBluetooth's onConnected() is the real success signal
 * The deinit→delay→init ordering is the key to avoiding the "no response / timeout" failures.
 */
class GlassesManager(
    private val appContext: Context,
    private val listener: GlassesListener,
) {
    private val api = CxrApi.getInstance()

    @Volatile var connected: Boolean = false
        private set

    // On-glasses display uses a CustomView (a TextView) rather than the AI_CHAT scene — AI_CHAT
    // waits for Rokid's official AI backend and just shows "连接中…" for a third-party app.
    @Volatile private var sceneOpen = false
    @Volatile private var viewReady = false
    private var customViewListenerRegistered = false
    @Volatile private var pendingText: String? = null
    @Volatile private var lastUserText: String = ""
    @Volatile private var latestShownText: String? = null
    /** Background opacity of the on-glasses view, 0..100 (% of black). */
    @Volatile private var bgOpacityPercent: Int = DEFAULT_BG_OPACITY
    /** On-glasses text size (sp) and display brightness (0..15) — tunable from settings. */
    @Volatile private var fontSizeSp: Int = DEFAULT_FONT_SIZE
    @Volatile private var brightness: Int = DEFAULT_BRIGHTNESS

    private val handler = Handler(Looper.getMainLooper())

    @Volatile private var targetMac: String? = null
    @Volatile private var isConnecting = false
    @Volatile private var attempt = 0
    private var pendingRetry: Runnable? = null
    private var timeout: Runnable? = null

    /** Bonded devices whose name hints they are Rokid glasses, plus all others as fallback. */
    fun listCandidateDevices(): List<GlassDevice> {
        if (!hasBtPermission()) return emptyList()
        val adapter = btAdapter() ?: return emptyList()
        return try {
            @SuppressLint("MissingPermission")
            val bonded = adapter.bondedDevices ?: emptySet()
            bonded.map { GlassDevice(deviceName(it), it.address) }
                .sortedByDescending { looksLikeGlasses(it.name) }
        } catch (e: SecurityException) {
            Log.w(TAG, "no bt permission: ${e.message}")
            emptyList()
        }
    }

    fun connect(mac: String) {
        if (!hasBtPermission()) {
            listener.onStatus(false, "需要蓝牙权限")
            return
        }
        if (btAdapter() == null) {
            listener.onStatus(false, "设备不支持蓝牙")
            return
        }
        if (isBluetoothConnected()) {
            connected = true
            listener.onStatus(true, "眼镜已连接")
            return
        }
        cancelPending()
        targetMac = mac
        attempt = 0
        attemptConnect()
    }

    /**
     * One connect attempt following the reference flow: deinit → delay → initBluetooth.
     * The actual link is completed in [initCallback].onConnectionInfo via connectBluetooth.
     */
    private fun attemptConnect() {
        pendingRetry = null
        val mac = targetMac ?: return
        val adapter = btAdapter() ?: return
        val device: BluetoothDevice = try {
            adapter.getRemoteDevice(mac)
        } catch (e: IllegalArgumentException) {
            listener.onStatus(false, "无效的设备地址")
            return
        }

        val label = if (attempt == 0) "正在连接眼镜…" else "正在连接眼镜…(重试 $attempt/$MAX_ATTEMPTS)"
        listener.onStatus(false, label)
        isConnecting = true

        // If the glasses are already system-connected, the SDK first disconnects internally and
        // needs more time — use a longer delay and timeout (matches the reference app).
        val deviceConnected = isDeviceConnected(device)

        // Clear any stale SDK state before initializing — the key to avoiding init no-response.
        try {
            api.deinitBluetooth()
        } catch (e: Throwable) {
            Log.w(TAG, "deinitBluetooth before init failed: ${e.message}")
        }

        val delayMs = if (deviceConnected) 1_000L else 200L
        val timeoutMs = if (deviceConnected) 20_000L else 10_000L
        handler.postDelayed({
            if (!isConnecting || targetMac == null) return@postDelayed
            try {
                api.initBluetooth(appContext, device, initCallback)
                armTimeout(timeoutMs)
            } catch (e: Throwable) {
                Log.e(TAG, "initBluetooth failed", e)
                onAttemptFailed("初始化异常")
            }
        }, delayMs)
    }

    /** Complete the link with the uuid/mac from onConnectionInfo (4-arg connect, no SN check). */
    private fun connectBluetoothStep(uuid: String, mac: String, timeoutMs: Long) {
        listener.onStatus(false, "正在建立连接…")
        try {
            api.connectBluetooth(appContext, uuid, mac, connectCallback)
            armTimeout(timeoutMs)
        } catch (e: Throwable) {
            Log.e(TAG, "connectBluetooth failed", e)
            onAttemptFailed("连接异常")
        }
    }

    private fun armTimeout(timeoutMs: Long) {
        timeout?.let { handler.removeCallbacks(it) }
        val t = Runnable { if (!connected) onAttemptFailed("超时(无响应)") }
        timeout = t
        handler.postDelayed(t, timeoutMs)
    }

    private fun onAttemptFailed(reason: String) {
        timeout?.let { handler.removeCallbacks(it) }
        timeout = null
        isConnecting = false
        if (connected || targetMac == null || pendingRetry != null) return
        if (attempt >= MAX_ATTEMPTS) {
            listener.onStatus(false, "连接失败: $reason")
            targetMac = null
            return
        }
        attempt += 1
        listener.onStatus(false, "连接失败($reason),${RETRY_DELAY_MS / 1000}秒后重试 $attempt/$MAX_ATTEMPTS…")
        val r = Runnable { attemptConnect() }
        pendingRetry = r
        handler.postDelayed(r, RETRY_DELAY_MS)
    }

    private fun cancelPending() {
        pendingRetry?.let { handler.removeCallbacks(it) }
        timeout?.let { handler.removeCallbacks(it) }
        pendingRetry = null
        timeout = null
    }

    fun disconnect() {
        targetMac = null
        isConnecting = false
        cancelPending()
        try {
            if (sceneOpen) closeScene()
            api.deinitBluetooth()
        } catch (_: Throwable) {
        }
        connected = false
        listener.onStatus(false, "已断开")
    }

    /** Open the on-glasses CustomView (a full-screen TextView) and register input listeners. */
    fun openAiChat() {
        if (!connected) return
        try {
            api.setAiEventListener(aiEventListener)
            api.setAudioStreamListener(audioStreamListener)
            api.setCustomCmdListener(customCmdListener)
            api.setCommunicationDevice()
        } catch (e: Throwable) {
            Log.w(TAG, "set listeners failed: ${e.message}")
        }
        openCustomView()
    }

    private fun openCustomView() {
        if (!connected) return
        // Idempotent: if the view is already open/opening, just (re)deliver text — a second
        // openCustomView without a close confuses the SDK and drops the onOpened callback.
        if (sceneOpen) {
            deliverPendingText()
            return
        }
        try {
            if (!customViewListenerRegistered) {
                api.setCustomViewListener(customViewListener)
                customViewListenerRegistered = true
            }
            val st = api.openCustomView(buildLayoutJson("等待消息…"))
            sceneOpen = true
            // Lower brightness reduces the optical ghosting (倒影) of bright text on the combiner.
            setBrightness(brightness)
            Log.i(TAG, "openCustomView -> $st")
        } catch (e: Throwable) {
            Log.e(TAG, "openCustomView failed", e)
        }
    }

    /** Set glasses display brightness (valid range 0..15); persists for later view opens. */
    fun setBrightness(value: Int) {
        brightness = value.coerceIn(0, 15)
        if (!connected) return
        try {
            api.setGlassBrightness(brightness)
        } catch (e: Throwable) {
            Log.w(TAG, "setGlassBrightness failed: ${e.message}")
        }
    }

    fun getBrightness(): Int = brightness

    /** Set the on-glasses text size (sp); updates the open view live and persists it. */
    fun setFontSize(sp: Int) {
        fontSizeSp = sp.coerceIn(MIN_FONT_SIZE, MAX_FONT_SIZE)
        if (!connected || !viewReady) return
        try {
            val payload = JSONArray().put(
                JSONObject()
                    .put("action", "update")
                    .put("id", TEXT_VIEW_ID)
                    .put("props", JSONObject().put("textSize", "${fontSizeSp}sp")),
            ).toString()
            api.updateCustomView(payload)
        } catch (e: Throwable) {
            Log.w(TAG, "setFontSize failed: ${e.message}")
        }
    }

    fun getFontSize(): Int = fontSizeSp

    /** Set the on-glasses background opacity (0..100 % of black); re-opens the view live. */
    fun setBackgroundOpacity(percent: Int) {
        bgOpacityPercent = percent.coerceIn(0, 100)
        if (!connected || !sceneOpen) return
        // Re-open with the new layout; redraw the current text once it reports ready.
        pendingText = latestShownText ?: pendingText
        viewReady = false
        try {
            api.closeCustomView()
        } catch (_: Throwable) {
        }
        openCustomView()
    }

    /** ARGB hex for the current background opacity, e.g. 10% -> "#1A000000". */
    private fun bgColorHex(): String {
        val alpha = (bgOpacityPercent * 255 / 100).coerceIn(0, 255)
        return "#%02X000000".format(alpha)
    }

    fun closeScene() {
        try {
            api.closeCustomView()
        } catch (_: Throwable) {
        }
        sceneOpen = false
        viewReady = false
    }

    /** Echo the user's text on the glasses. */
    fun showUserText(text: String) {
        lastUserText = text
        renderText("🗣 $text")
    }

    /** Signal the glasses that the AI is now generating a reply. */
    fun notifyThinking() {
        val prefix = if (lastUserText.isNotBlank()) "🗣 $lastUserText\n\n" else ""
        renderText("$prefix⋯ 思考中")
    }

    /** Push an AI reply to the glasses display. */
    fun showAiReply(text: String) = renderText(text)

    fun notifyError() = renderText("⚠️ 出错了，请重试")

    /** Update the on-glasses TextView, buffering until the CustomView reports ready. */
    private fun renderText(text: String) {
        if (!connected) return
        pendingText = text
        if (!sceneOpen) openCustomView()
        if (!viewReady) return
        try {
            val st = api.updateCustomView(buildUpdatePayload(text))
            if (st != ValueUtil.CxrStatus.REQUEST_FAILED) {
                pendingText = null
                latestShownText = text
            }
        } catch (e: Throwable) {
            Log.w(TAG, "updateCustomView failed: ${e.message}")
        }
    }

    private fun deliverPendingText() {
        val t = pendingText ?: return
        try {
            if (api.updateCustomView(buildUpdatePayload(t)) != ValueUtil.CxrStatus.REQUEST_FAILED) {
                pendingText = null
            }
        } catch (e: Throwable) {
            Log.w(TAG, "deliverPendingText failed: ${e.message}")
        }
    }

    /** Initial CustomView layout: one full-screen TextView with id `tv_content`. */
    private fun buildLayoutJson(initialText: String): String {
        val tv = JSONObject()
            .put("type", "TextView")
            .put(
                "props",
                JSONObject()
                    .put("id", TEXT_VIEW_ID)
                    .put("layout_width", "match_parent")
                    .put("layout_height", "match_parent")
                    .put("text", initialText)
                    .put("textSize", "${fontSizeSp}sp")
                    .put("textColor", "#FFFFFFFF")
                    .put("gravity", "start|top"),
            )
        return JSONObject()
            .put("type", "LinearLayout")
            .put(
                "props",
                JSONObject()
                    .put("layout_width", "match_parent")
                    .put("layout_height", "match_parent")
                    .put("orientation", "vertical")
                    // Background opacity is tunable; higher % covers more of the glasses home UI
                    // (clock / battery / "唤起AI助手" hint) behind our view.
                    .put("backgroundColor", bgColorHex()),
            )
            .put("children", JSONArray().put(tv))
            .toString()
    }

    /** Update payload: a JSON array setting the TextView text. */
    private fun buildUpdatePayload(text: String): String {
        val capped = if (text.length <= MAX_TEXT) text else text.take(MAX_TEXT) + "…"
        val op = JSONObject()
            .put("action", "update")
            .put("id", TEXT_VIEW_ID)
            .put("props", JSONObject().put("text", capped))
        return JSONArray().put(op).toString()
    }

    // Phase 1 callback (initBluetooth): onConnectionInfo provides uuid/mac, then we connectBluetooth.
    private val initCallback = object : BluetoothStatusCallback {
        override fun onConnectionInfo(uuid: String?, mac: String?, account: String?, type: Int) {
            Log.i(TAG, "initBluetooth.onConnectionInfo uuid=$uuid mac=$mac type=$type")
            handler.post {
                timeout?.let { handler.removeCallbacks(it) }
                if (targetMac == null || uuid.isNullOrBlank() || mac.isNullOrBlank()) {
                    onAttemptFailed("参数无效")
                    return@post
                }
                connectBluetoothStep(uuid, mac, 10_000L)
            }
        }

        // initBluetooth's onConnected may be empty; the real success is connectBluetooth's onConnected.
        override fun onConnected() {}
        override fun onDisconnected() { handler.post { handleDisconnected() } }
        override fun onFailed(code: ValueUtil.CxrBluetoothErrorCode?) {
            Log.w(TAG, "initBluetooth.onFailed: ${code?.name}")
            handler.post { onAttemptFailed(code?.name ?: "初始化失败") }
        }
    }

    // Phase 2 callback (connectBluetooth): onConnected here is the real connection success.
    private val connectCallback = object : BluetoothStatusCallback {
        override fun onConnectionInfo(uuid: String?, mac: String?, account: String?, type: Int) {}

        override fun onConnected() {
            handler.post {
                cancelPending()
                isConnecting = false
                attempt = 0
                connected = true
                listener.onStatus(true, "眼镜已连接")
            }
        }

        override fun onDisconnected() { handler.post { handleDisconnected() } }

        override fun onFailed(code: ValueUtil.CxrBluetoothErrorCode?) {
            Log.w(TAG, "connectBluetooth.onFailed: ${code?.name}")
            handler.post { onAttemptFailed(code?.name ?: "连接失败") }
        }
    }

    private fun handleDisconnected() {
        connected = false
        sceneOpen = false
        if (!isConnecting) listener.onStatus(false, "眼镜已断开")
    }

    private val customViewListener = object : CustomViewListener {
        override fun onIconsSent() {}
        override fun onOpened() {
            Log.i(TAG, "CustomView opened")
            viewReady = true
            sceneOpen = true
            handler.post { deliverPendingText() }
        }
        override fun onOpenFailed(errorCode: Int) {
            Log.e(TAG, "CustomView openFailed: $errorCode")
            viewReady = false
            sceneOpen = false
        }
        override fun onUpdated() {}
        override fun onClosed() {
            viewReady = false
            sceneOpen = false
        }
    }

    private val aiEventListener = object : AiEventListener {
        override fun onAiKeyDown() { Log.i(TAG, "GESTURE onAiKeyDown"); listener.onAiKeyDown() }
        override fun onAiKeyUp() { Log.i(TAG, "GESTURE onAiKeyUp"); listener.onAiKeyUp() }
        override fun onAiExit() { Log.i(TAG, "GESTURE onAiExit"); listener.onAiExit() }
    }

    // Diagnostic: log any custom command the glasses send (e.g. touchpad gestures in CustomView).
    private val customCmdListener = object : CustomCmdListener {
        override fun onCustomCmd(cmd: String?, caps: Caps?) {
            val arg = try { if (caps != null && caps.size() > 0) caps.at(0).getString() else null } catch (_: Throwable) { null }
            Log.i(TAG, "GESTURE onCustomCmd cmd=$cmd arg=$arg")
        }
    }

    /** Glasses-mic PCM stream. Currently unused (phone STT is the primary path); kept for parity. */
    private val audioStreamListener = object : AudioStreamListener {
        override fun onStartAudioStream(p0: Int, p1: String?) {}
        override fun onAudioStream(p0: ByteArray?, p1: Int, p2: Int) {}
    }

    private fun isBluetoothConnected(): Boolean = try {
        api.isBluetoothConnected()
    } catch (e: Throwable) {
        false
    }

    /** Whether the device is already connected at the system level (affects delay/timeout). */
    @SuppressLint("MissingPermission")
    private fun isDeviceConnected(device: BluetoothDevice): Boolean = try {
        device.javaClass.getMethod("isConnected").invoke(device) as? Boolean ?: false
    } catch (e: Throwable) {
        false
    }

    private fun btAdapter(): BluetoothAdapter? =
        (appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun deviceName(d: BluetoothDevice): String = try {
        @SuppressLint("MissingPermission")
        val n = d.name
        n ?: d.address
    } catch (e: SecurityException) {
        d.address
    }

    private fun looksLikeGlasses(name: String): Boolean {
        val n = name.lowercase()
        return n.contains("rokid") || n.contains("glass")
    }

    private fun hasBtPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(appContext, Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val TAG = "GlassesManager"
        private const val MAX_ATTEMPTS = 3
        private const val RETRY_DELAY_MS = 2_000L
        private const val TEXT_VIEW_ID = "tv_content"
        private const val MAX_TEXT = 500
        /** Lower default brightness to reduce ghosting of bright text (range 0..15). */
        private const val DEFAULT_BRIGHTNESS = 5
        private const val DEFAULT_FONT_SIZE = 22
        private const val MIN_FONT_SIZE = 14
        private const val MAX_FONT_SIZE = 40
        /** Default background opacity (% of black), 0..100. */
        private const val DEFAULT_BG_OPACITY = 10
    }
}
