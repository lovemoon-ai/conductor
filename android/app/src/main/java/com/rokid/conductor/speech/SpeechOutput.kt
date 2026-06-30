package com.rokid.conductor.speech

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.RemoteException
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.rokid.os.sprite.tts.ITtsListener
import com.rokid.os.sprite.tts.ITtsServer
import java.util.Locale
import java.util.UUID

/**
 * Text-to-speech for reading AI replies on glasses.
 *
 * Keeps the TTS engine lifecycle isolated from the chat state machine.
 */
class SpeechOutput(
    context: Context,
    private val onAvailability: (available: Boolean, status: String) -> Unit,
    private val onSpeakingChanged: (Boolean) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val tts: TextToSpeech? = if (hasStandardTtsEngine()) {
        TextToSpeech(appContext) { status -> handleInit(status) }
    } else {
        null
    }
    private val rokidTtsListener = object : ITtsListener.Stub() {
        override fun onTtsStart(uuid: String?) {
            if (uuid == currentRokidUtteranceId) setSpeaking(true)
        }

        override fun onTtsStop(uuid: String?) {
            if (uuid == currentRokidUtteranceId) {
                currentRokidUtteranceId = null
                setSpeaking(false)
            }
        }
    }
    private val rokidConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            rokidServer = ITtsServer.Stub.asInterface(service)
            rokidBinding = false
            ready = true
            available = true
            post { onAvailability(true, "Rokid 语音朗读就绪") }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            rokidServer = null
            rokidBinding = false
            if (!androidTtsAvailable) {
                available = false
                post { onAvailability(false, "语音朗读服务已断开") }
            }
            setSpeaking(false)
        }
    }

    @Volatile private var androidTtsReady: Boolean = false
    @Volatile private var androidTtsAvailable: Boolean = false
    @Volatile private var rokidBinding: Boolean = false
    @Volatile private var rokidBound: Boolean = false
    @Volatile private var rokidServer: ITtsServer? = null
    @Volatile private var currentRokidUtteranceId: String? = null

    @Volatile var ready: Boolean = false
        private set
    @Volatile var available: Boolean = false
        private set
    @Volatile var speaking: Boolean = false
        private set

    init {
        bindRokidTts()
    }

    private fun handleInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            androidTtsReady = false
            androidTtsAvailable = false
            bindRokidTts()
            return
        }

        androidTtsReady = true
        val engine = tts ?: return
        engine.setPitch(1.0f)
        engine.setSpeechRate(0.92f)
        engine.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    setSpeaking(true)
                }

                override fun onDone(utteranceId: String?) {
                    setSpeaking(false)
                }

                @Deprecated("Deprecated by Android framework")
                override fun onError(utteranceId: String?) {
                    setSpeaking(false)
                    post { onError("语音朗读失败") }
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    setSpeaking(false)
                    post { onError("语音朗读失败 ($errorCode)") }
                }
            }
        )

        androidTtsAvailable = configureLanguage("")
        ready = true
        available = androidTtsAvailable || rokidServer != null
        if (!androidTtsAvailable) {
            bindRokidTts()
        }
        post {
            onAvailability(
                available,
                if (available) "语音朗读就绪" else "正在连接 Rokid 语音朗读",
            )
        }
    }

    fun speak(text: String): Boolean {
        val spoken = cleanForSpeech(text)
        if (spoken.isBlank()) {
            post { onError("没有可朗读内容") }
            return false
        }

        rokidServer?.let { return speakWithRokid(it, spoken) }

        if (!ready) {
            bindRokidTts()
            post { onError("语音朗读仍在初始化") }
            return false
        }

        if (!androidTtsReady || !configureLanguage(spoken)) {
            androidTtsAvailable = false
            bindRokidTts()
            post { onError("正在连接 Rokid 语音朗读") }
            return false
        }

        val params = Bundle().apply {
            putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
        }
        val engine = tts
        if (engine == null) {
            bindRokidTts()
            post { onError("正在连接 Rokid 语音朗读") }
            return false
        }
        val result = engine.speak(spoken, TextToSpeech.QUEUE_FLUSH, params, UUID.randomUUID().toString())
        if (result != TextToSpeech.SUCCESS) {
            setSpeaking(false)
            post { onError("无法开始语音朗读") }
            return false
        }
        return true
    }

    fun stop() {
        val rokidId = currentRokidUtteranceId
        val server = rokidServer
        if (server != null && rokidId != null) {
            try {
                server.stopTtsPlay(rokidId)
            } catch (_: RemoteException) {
            } catch (_: Throwable) {
            }
            currentRokidUtteranceId = null
        }
        try {
            tts?.stop()
        } catch (_: Throwable) {
        }
        setSpeaking(false)
    }

    fun shutdown() {
        stop()
        try {
            tts?.shutdown()
        } catch (_: Throwable) {
        }
        if (rokidBound) {
            try {
                appContext.unbindService(rokidConnection)
            } catch (_: Throwable) {
            }
            rokidBound = false
        }
    }

    private fun configureLanguage(text: String): Boolean {
        val engine = tts ?: return false
        val preferred = if (text.containsCjk()) Locale.SIMPLIFIED_CHINESE else Locale.getDefault()
        if (engine.setLanguage(preferred).isSupportedLanguage()) return true
        return engine.setLanguage(Locale.US).isSupportedLanguage()
    }

    private fun hasStandardTtsEngine(): Boolean {
        return appContext.packageManager
            .queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0)
            .isNotEmpty()
    }

    private fun bindRokidTts() {
        if (rokidBinding || rokidServer != null) return
        try {
            val intent = Intent().setComponent(
                ComponentName(RokidTtsPackage, RokidTtsService)
            )
            rokidBinding = true
            rokidBound = appContext.bindService(intent, rokidConnection, Context.BIND_AUTO_CREATE)
            if (!rokidBound) {
                rokidBinding = false
                available = androidTtsAvailable
                post {
                    onAvailability(
                        available,
                        if (available) "语音朗读就绪" else "设备未安装可用语音朗读引擎",
                    )
                }
            }
        } catch (_: Throwable) {
            rokidBinding = false
            available = androidTtsAvailable
            post {
                onAvailability(
                    available,
                    if (available) "语音朗读就绪" else "设备未安装可用语音朗读引擎",
                )
            }
        }
    }

    private fun speakWithRokid(server: ITtsServer, text: String): Boolean {
        val utteranceId = UUID.randomUUID().toString()
        return try {
            currentRokidUtteranceId = utteranceId
            server.playTtsMsg(text, utteranceId, rokidTtsListener)
            true
        } catch (_: RemoteException) {
            currentRokidUtteranceId = null
            rokidServer = null
            setSpeaking(false)
            bindRokidTts()
            post { onError("Rokid 语音朗读服务断开") }
            false
        } catch (e: Throwable) {
            currentRokidUtteranceId = null
            setSpeaking(false)
            post { onError("Rokid 语音朗读失败: ${e.message}") }
            false
        }
    }

    private fun setSpeaking(value: Boolean) {
        speaking = value
        post { onSpeakingChanged(value) }
    }

    private fun post(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    companion object {
        private const val MaxSpeechChars = 700
        private const val RokidTtsPackage = "com.rokid.os.sprite.assistserver"
        private const val RokidTtsService = "com.rokid.os.sprite.tts.TtsService"

        private fun Int.isSupportedLanguage(): Boolean =
            this != TextToSpeech.LANG_MISSING_DATA && this != TextToSpeech.LANG_NOT_SUPPORTED

        private fun String.containsCjk(): Boolean = any { ch ->
            ch.code in 0x4E00..0x9FFF ||
                ch.code in 0x3400..0x4DBF ||
                ch.code in 0x3040..0x30FF ||
                ch.code in 0xAC00..0xD7AF
        }

        private fun cleanForSpeech(value: String): String {
            return value
                .replace(Regex("```[\\s\\S]*?```"), " 代码省略 ")
                .replace(Regex("`([^`]+)`"), "$1")
                .replace(Regex("\\[([^\\]]+)]\\([^)]*\\)"), "$1")
                .replace(Regex("[#>*_~\\-]+"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()
                .take(MaxSpeechChars)
        }
    }
}
