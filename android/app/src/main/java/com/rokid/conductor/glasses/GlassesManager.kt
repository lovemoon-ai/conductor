package com.rokid.conductor.glasses

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.rokid.cxr.client.extend.CxrApi
import com.rokid.cxr.client.extend.callbacks.BluetoothStatusCallback
import com.rokid.cxr.client.extend.listeners.AiEventListener
import com.rokid.cxr.client.extend.listeners.AudioStreamListener
import com.rokid.cxr.client.utils.ValueUtil

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
 * Connects over Bluetooth and drives the on-glasses AI_CHAT scene.
 */
class GlassesManager(
    private val appContext: Context,
    private val listener: GlassesListener,
) {
    private val api = CxrApi.getInstance()

    @Volatile var connected: Boolean = false
        private set
    @Volatile private var sceneOpen = false

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
        val adapter = btAdapter()
        if (adapter == null) {
            listener.onStatus(false, "设备不支持蓝牙")
            return
        }
        val device: BluetoothDevice = try {
            adapter.getRemoteDevice(mac)
        } catch (e: IllegalArgumentException) {
            listener.onStatus(false, "无效的设备地址")
            return
        }
        listener.onStatus(false, "正在连接眼镜…")
        try {
            api.initBluetooth(appContext, device, statusCallback)
        } catch (e: Throwable) {
            Log.e(TAG, "initBluetooth failed", e)
            listener.onStatus(false, "连接失败: ${e.message}")
        }
    }

    fun disconnect() {
        try {
            if (sceneOpen) closeScene()
            api.deinitBluetooth()
        } catch (_: Throwable) {
        }
        connected = false
        listener.onStatus(false, "已断开")
    }

    /** Open the on-glasses AI conversation scene and register event listeners. */
    fun openAiChat() {
        if (!connected) return
        try {
            api.setAiEventListener(aiEventListener)
            api.setAudioStreamListener(audioStreamListener)
            api.setCommunicationDevice()
            val st = api.controlScene(ValueUtil.CxrSceneType.AI_CHAT, true, null)
            sceneOpen = true
            Log.i(TAG, "open AI_CHAT -> $st")
        } catch (e: Throwable) {
            Log.e(TAG, "openAiChat failed", e)
        }
    }

    fun closeScene() {
        try {
            api.controlScene(ValueUtil.CxrSceneType.AI_CHAT, false, null)
        } catch (_: Throwable) {
        }
        sceneOpen = false
    }

    /** Echo the user's (recognized) text on the glasses. */
    fun showUserText(text: String) = safe { api.sendAsrContent(text) }

    /** Signal the glasses that the AI is now generating a reply. */
    fun notifyThinking() = safe { api.notifyAiStart() }

    /** Push an AI reply to the glasses display. */
    fun showAiReply(text: String) = safe {
        api.sendTtsContent(text)
        api.notifyTtsAudioFinished()
    }

    fun notifyError() = safe { api.notifyAiError() }

    private inline fun safe(block: () -> Unit) {
        if (!connected) return
        try { block() } catch (e: Throwable) { Log.w(TAG, "glass cmd failed: ${e.message}") }
    }

    private val statusCallback = object : BluetoothStatusCallback {
        override fun onConnectionInfo(uuid: String?, mac: String?, account: String?, type: Int) {
            Log.i(TAG, "onConnectionInfo uuid=$uuid mac=$mac account=$account type=$type")
            if (!account.isNullOrBlank()) {
                try { api.updateRokidAccount(account) } catch (_: Throwable) {}
            }
        }

        override fun onConnected() {
            connected = true
            listener.onStatus(true, "眼镜已连接")
        }

        override fun onInActiveConnected(p0: String?, p1: String?) {
            listener.onStatus(false, "眼镜在线，待激活")
        }

        override fun onDisconnected() {
            connected = false
            sceneOpen = false
            listener.onStatus(false, "眼镜已断开")
        }

        override fun onFailed(code: ValueUtil.CxrBluetoothErrorCode?) {
            connected = false
            listener.onStatus(false, "连接失败: ${code?.name ?: "未知"}")
        }
    }

    private val aiEventListener = object : AiEventListener {
        override fun onAiKeyDown() = listener.onAiKeyDown()
        override fun onAiKeyUp() = listener.onAiKeyUp()
        override fun onAiExit() = listener.onAiExit()
    }

    /** Glasses-mic PCM stream. Currently unused (phone STT is the primary path); kept for parity. */
    private val audioStreamListener = object : AudioStreamListener {
        override fun onStartAudioStream(p0: Int, p1: Int, p2: Int, p3: String?) {}
        override fun onAudioStream(p0: Int, p1: ByteArray?, p2: Int, p3: Int) {}
        override fun onAudioStreamFinish(p0: Int) {}
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
    }
}
