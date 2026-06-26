package com.rokid.conductor.bridge

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.rokid.conductor.glasses.GlassesListener
import com.rokid.conductor.glasses.GlassesManager
import com.rokid.conductor.glasses.TtsManager
import com.rokid.conductor.speech.AudioStt
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bridges the native glasses + speech capabilities into the WebView-hosted Conductor frontend.
 *
 * Exposed to JavaScript as `window.RokidGlassesNative`. The web "glasses adapter"
 * ([web]/src/features/glasses/native-bridge.ts) calls these methods to drive the on-glasses
 * AI_CHAT scene, and receives glasses/STT events through the `window.__rokidOn*` callbacks.
 *
 * All UI and business logic (auth, projects, tasks, chat, realtime) lives in the web app;
 * this bridge only owns what the browser cannot do: Bluetooth glasses + phone STT.
 *
 * @JavascriptInterface methods are invoked on a private WebView binder thread, so any call
 * touching [SpeechInput] (main-thread only) or the WebView is marshalled onto the main thread.
 */
class GlassesBridge(
    private val appContext: Context,
    private val webView: WebView,
) : GlassesListener {

    private val main = Handler(Looper.getMainLooper())

    private val glasses = GlassesManager(appContext, this)

    private var speech: AudioStt? = null
    @Volatile private var listening = false

    private val tts = TtsManager(appContext, onDone = { emit("__rokidOnSpeakDone") })

    // ---- JS -> native: commands ----------------------------------------------------------

    /** Probe used by the web adapter to detect it is running inside the Android shell. */
    @JavascriptInterface
    fun isPresent(): Boolean = true

    /** JSON array string of bonded candidate devices: `[{"name":..,"mac":..}]`. */
    @JavascriptInterface
    fun listDevices(): String {
        val arr = JSONArray()
        glasses.listCandidateDevices().forEach { d ->
            arr.put(JSONObject().put("name", d.name).put("mac", d.mac))
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun connect(mac: String) = onMain { glasses.connect(mac) }

    @JavascriptInterface
    fun disconnect() = onMain { glasses.disconnect() }

    @JavascriptInterface
    fun isConnected(): Boolean = glasses.connected

    @JavascriptInterface
    fun openAiChat() = onMain { glasses.openAiChat() }

    @JavascriptInterface
    fun closeScene() = onMain { glasses.closeScene() }

    /** Echo the user's text on the glasses (sendAsrContent). */
    @JavascriptInterface
    fun showUserText(text: String) = onMain { glasses.showUserText(text) }

    /** Tell the glasses the AI began generating (notifyAiStart). */
    @JavascriptInterface
    fun notifyThinking() = onMain { glasses.notifyThinking() }

    /** Push an AI reply to the lens (sendTtsContent + finish). */
    @JavascriptInterface
    fun showAiReply(text: String) = onMain { glasses.showAiReply(text) }

    @JavascriptInterface
    fun notifyError() = onMain { glasses.notifyError() }

    /** Set glasses brightness (0..15); lower reduces text ghosting. */
    @JavascriptInterface
    fun setBrightness(value: Int) = onMain { glasses.setBrightness(value) }

    /** Set on-glasses background opacity (0..100 % of black). */
    @JavascriptInterface
    fun setBackgroundOpacity(percent: Int) = onMain { glasses.setBackgroundOpacity(percent) }

    /** Set on-glasses text size in sp (14..40). */
    @JavascriptInterface
    fun setFontSize(sp: Int) = onMain { glasses.setFontSize(sp) }

    /** Current on-glasses text size (sp). */
    @JavascriptInterface
    fun getFontSize(): Int = glasses.getFontSize()

    /** Current glasses brightness (0..15). */
    @JavascriptInterface
    fun getBrightness(): Int = glasses.getBrightness()

    /** Speak [text] aloud (queued); audio routes to the glasses speaker. */
    @JavascriptInterface
    fun speak(text: String) = tts.speak(text)

    /** Stop any in-progress/queued speech. */
    @JavascriptInterface
    fun stopSpeak() = tts.stop()

    /** Push-to-talk start. Phone STT captures the glasses mic when connected. */
    @JavascriptInterface
    fun startVoice() = onMain { startVoiceInternal() }

    /** Stop recording; the cloud ASR then delivers a final result via __rokidOnSttFinal. */
    @JavascriptInterface
    fun stopVoice() = onMain {
        listening = false
        speech?.stop()
    }

    // ---- native -> JS: events (GlassesListener) ------------------------------------------

    override fun onStatus(connected: Boolean, text: String) =
        emit("__rokidOnGlassStatus", connected, text)

    override fun onAiKeyDown() = emit("__rokidOnAiKeyDown")
    override fun onAiKeyUp() = emit("__rokidOnAiKeyUp")
    override fun onAiExit() = emit("__rokidOnAiExit")

    // ---- speech --------------------------------------------------------------------------

    private fun startVoiceInternal() {
        if (listening) return
        val si = speech ?: AudioStt(
            context = appContext,
            onFinal = { text ->
                listening = false
                emit("__rokidOnSttFinal", text)
            },
            onError = { msg ->
                listening = false
                emit("__rokidOnSttError", msg)
            },
        ).also { speech = it }
        listening = true
        si.start()
    }

    fun release() {
        speech?.cancel()
        speech = null
        tts.release()
        glasses.disconnect()
    }

    // ---- helpers -------------------------------------------------------------------------

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block()
        else main.post(block)
    }

    /** Invoke a `window.<fn>(...args)` callback in the page, JSON-encoding each argument. */
    private fun emit(fn: String, vararg args: Any?) {
        val encoded = args.joinToString(",") { JSONObject.quote(it?.toString() ?: "").let { s ->
            when (it) {
                is Boolean -> it.toString()
                null -> "null"
                else -> s
            }
        } }
        val js = "if(window.$fn)window.$fn($encoded);"
        webView.post { webView.evaluateJavascript(js, null) }
    }
}
