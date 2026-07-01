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
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

internal const val SpeechOutputMaxChunkChars = 220

internal fun cleanTextForSpeech(value: String): String {
    return value
        .replace(Regex("```[\\s\\S]*?```"), " 代码省略 ")
        .replace(Regex("`([^`]+)`"), "$1")
        .replace(Regex("\\[([^\\]]+)]\\([^)]*\\)"), "$1")
        .replace(Regex("[#>*_~\\-]+"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
}

internal fun splitTextForSpeech(
    value: String,
    maxChunkChars: Int = SpeechOutputMaxChunkChars,
): List<String> {
    require(maxChunkChars > 0) { "maxChunkChars must be positive" }
    var remaining = cleanTextForSpeech(value)
    if (remaining.isBlank()) return emptyList()

    val chunks = mutableListOf<String>()
    while (remaining.length > maxChunkChars) {
        val splitAt = findSpeechSplitIndex(remaining, maxChunkChars)
        remaining.substring(0, splitAt).trim().takeIf { it.isNotBlank() }?.let(chunks::add)
        remaining = remaining.substring(splitAt).trim()
    }
    remaining.takeIf { it.isNotBlank() }?.let(chunks::add)
    return chunks
}

private fun findSpeechSplitIndex(text: String, maxChunkChars: Int): Int {
    val end = maxChunkChars.coerceAtMost(text.length)
    val minSplit = (end * 0.45f).toInt().coerceAtLeast(1)
    val preferredBreaks = "。！？；，、.!?;,:："
    for (index in end - 1 downTo minSplit) {
        if (preferredBreaks.contains(text[index])) return index + 1
    }
    for (index in end - 1 downTo minSplit) {
        if (text[index].isWhitespace()) return index + 1
    }
    return end
}

internal enum class SpeechEngine { ANDROID, ROKID }

internal fun speechEnginePriority(
    hasRokidServer: Boolean,
    skipEngine: SpeechEngine? = null,
): List<SpeechEngine> {
    val engines = if (hasRokidServer) {
        listOf(SpeechEngine.ROKID, SpeechEngine.ANDROID)
    } else {
        listOf(SpeechEngine.ANDROID, SpeechEngine.ROKID)
    }
    return engines.filter { it != skipEngine }
}

/**
 * Text-to-speech for reading AI replies on glasses.
 *
 * Keeps the TTS engine lifecycle isolated from the chat state machine.
 */
class SpeechOutput(
    context: Context,
    private val onAvailability: (available: Boolean, status: String) -> Unit,
    private val onSpeakingChanged: (Boolean) -> Unit,
    private val onChunkStarted: (chunkIndex: Int, chunkCount: Int) -> Unit,
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
            if (markStarted(uuid, SpeechEngine.ROKID)) {
                notifyChunkStarted()
                setSpeaking(true)
            }
        }

        override fun onTtsStop(uuid: String?) {
            completeChunk(uuid, SpeechEngine.ROKID)
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
            val interruptedId = currentRokidUtteranceId
            rokidServer = null
            rokidBinding = false
            if (!androidTtsAvailable) {
                available = false
                post { onAvailability(false, "语音朗读服务已断开") }
            }
            if (interruptedId != null) {
                failChunk(interruptedId, SpeechEngine.ROKID, "Rokid 语音朗读服务已断开")
            }
        }
    }

    private val playbackLock = Any()
    private val pendingChunks = ArrayDeque<String>()

    @Volatile private var androidTtsReady: Boolean = false
    @Volatile private var androidTtsAvailable: Boolean = false
    @Volatile private var rokidBinding: Boolean = false
    @Volatile private var rokidBound: Boolean = false
    @Volatile private var rokidServer: ITtsServer? = null
    @Volatile private var currentAndroidUtteranceId: String? = null
    @Volatile private var currentRokidUtteranceId: String? = null
    @Volatile private var currentChunkText: String? = null
    @Volatile private var currentEngine: SpeechEngine? = null
    @Volatile private var currentUtteranceStarted: Boolean = false
    @Volatile private var currentChunkIndex: Int = 0
    @Volatile private var nextChunkIndex: Int = 0
    @Volatile private var currentSpeechChunkCount: Int = 0

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
                    if (markStarted(utteranceId, SpeechEngine.ANDROID)) {
                        notifyChunkStarted()
                        setSpeaking(true)
                    }
                }

                override fun onDone(utteranceId: String?) {
                    completeChunk(utteranceId, SpeechEngine.ANDROID)
                }

                @Deprecated("Deprecated by Android framework")
                override fun onError(utteranceId: String?) {
                    failChunk(utteranceId, SpeechEngine.ANDROID, "语音朗读失败")
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    failChunk(utteranceId, SpeechEngine.ANDROID, "语音朗读失败 ($errorCode)")
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
        val chunks = splitTextForSpeech(text)
        if (chunks.isEmpty()) {
            post { onError("没有可朗读内容") }
            return false
        }

        if (!ready) {
            bindRokidTts()
            post { onError("语音朗读仍在初始化") }
            return false
        }

        synchronized(playbackLock) {
            if (!hasActiveChunkLocked() && pendingChunks.isEmpty()) {
                currentSpeechChunkCount = chunks.size
                nextChunkIndex = 0
                currentChunkIndex = 0
            } else {
                currentSpeechChunkCount += chunks.size
            }
            pendingChunks.addAll(chunks)
            if (hasActiveChunkLocked()) return true
        }
        return startNextChunk()
    }

    private fun startNextChunk(): Boolean {
        val chunk = synchronized(playbackLock) {
            if (hasActiveChunkLocked()) return true
            val next = pendingChunks.pollFirst() ?: run {
                resetChunkProgressLocked()
                return false
            }
            currentChunkIndex = nextChunkIndex
            nextChunkIndex += 1
            next
        }
        if (startChunk(chunk)) return true
        synchronized(playbackLock) {
            clearCurrentChunkLocked()
            pendingChunks.clear()
            resetChunkProgressLocked()
        }
        setSpeaking(false)
        post { onError("无法开始语音朗读") }
        return false
    }

    private fun startChunk(text: String, skipEngine: SpeechEngine? = null): Boolean {
        val server = rokidServer
        for (engine in speechEnginePriority(hasRokidServer = server != null, skipEngine = skipEngine)) {
            when (engine) {
                SpeechEngine.ROKID -> if (server != null && speakWithRokid(server, text)) return true
                SpeechEngine.ANDROID -> if (speakWithAndroid(text)) return true
            }
        }
        if (server == null) bindRokidTts()
        return false
    }

    private fun speakWithAndroid(text: String): Boolean {
        if (!androidTtsReady || !configureLanguage(text)) {
            androidTtsAvailable = false
            return false
        }
        val params = Bundle().apply {
            putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
        }
        val engine = tts ?: return false
        val utteranceId = UUID.randomUUID().toString()
        synchronized(playbackLock) {
            currentAndroidUtteranceId = utteranceId
            currentRokidUtteranceId = null
            currentChunkText = text
            currentEngine = SpeechEngine.ANDROID
            currentUtteranceStarted = false
        }
        val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        if (result != TextToSpeech.SUCCESS) {
            synchronized(playbackLock) {
                if (currentAndroidUtteranceId == utteranceId) clearCurrentChunkLocked()
            }
            return false
        }
        scheduleStartWatchdog(utteranceId, SpeechEngine.ANDROID)
        return true
    }

    fun stop() {
        val rokidId = currentRokidUtteranceId
        val server = rokidServer
        synchronized(playbackLock) {
            pendingChunks.clear()
            clearCurrentChunkLocked()
            resetChunkProgressLocked()
        }
        if (server != null && rokidId != null) {
            try {
                server.stopTtsPlay(rokidId)
            } catch (_: RemoteException) {
            } catch (_: Throwable) {
            }
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
            synchronized(playbackLock) {
                currentAndroidUtteranceId = null
                currentRokidUtteranceId = utteranceId
                currentChunkText = text
                currentEngine = SpeechEngine.ROKID
                currentUtteranceStarted = false
            }
            server.playTtsMsg(text, utteranceId, rokidTtsListener)
            scheduleStartWatchdog(utteranceId, SpeechEngine.ROKID)
            true
        } catch (_: RemoteException) {
            synchronized(playbackLock) {
                if (currentRokidUtteranceId == utteranceId) clearCurrentChunkLocked()
            }
            rokidServer = null
            bindRokidTts()
            false
        } catch (_: Throwable) {
            synchronized(playbackLock) {
                if (currentRokidUtteranceId == utteranceId) clearCurrentChunkLocked()
            }
            false
        }
    }

    private fun markStarted(utteranceId: String?, engine: SpeechEngine): Boolean {
        return synchronized(playbackLock) {
            if (!isCurrentChunkLocked(utteranceId, engine)) return@synchronized false
            currentUtteranceStarted = true
            true
        }
    }

    private fun notifyChunkStarted() {
        val progress = synchronized(playbackLock) {
            currentChunkIndex to currentSpeechChunkCount.coerceAtLeast(1)
        }
        post { onChunkStarted(progress.first, progress.second) }
    }

    private fun completeChunk(utteranceId: String?, engine: SpeechEngine) {
        var shouldStartNext = false
        val matched = synchronized(playbackLock) {
            if (!isCurrentChunkLocked(utteranceId, engine)) return@synchronized false
            clearCurrentChunkLocked()
            shouldStartNext = pendingChunks.isNotEmpty()
            if (!shouldStartNext) resetChunkProgressLocked()
            true
        }
        if (!matched) return
        if (shouldStartNext) {
            if (!startNextChunk()) setSpeaking(false)
        } else {
            setSpeaking(false)
        }
    }

    private fun failChunk(utteranceId: String?, engine: SpeechEngine, message: String) {
        val retryText = synchronized(playbackLock) {
            if (!isCurrentChunkLocked(utteranceId, engine)) return@synchronized null
            currentChunkText.also { clearCurrentChunkLocked() }
        }
        if (retryText != null && startChunk(retryText, skipEngine = engine)) return
        synchronized(playbackLock) {
            pendingChunks.clear()
            resetChunkProgressLocked()
        }
        setSpeaking(false)
        post { onError(message) }
    }

    private fun scheduleStartWatchdog(utteranceId: String, engine: SpeechEngine) {
        mainHandler.postDelayed(
            {
                val retryText = synchronized(playbackLock) {
                    if (!isCurrentChunkLocked(utteranceId, engine) || currentUtteranceStarted) {
                        return@synchronized null
                    }
                    currentChunkText.also { clearCurrentChunkLocked() }
                }
                if (retryText != null && startChunk(retryText, skipEngine = engine)) return@postDelayed
                if (retryText != null) {
                    synchronized(playbackLock) {
                        pendingChunks.clear()
                        resetChunkProgressLocked()
                    }
                    setSpeaking(false)
                    post { onError("语音朗读启动超时") }
                }
            },
            StartTimeoutMs,
        )
    }

    private fun hasActiveChunkLocked(): Boolean =
        currentEngine != null || currentAndroidUtteranceId != null || currentRokidUtteranceId != null

    private fun isCurrentChunkLocked(utteranceId: String?, engine: SpeechEngine): Boolean {
        if (utteranceId.isNullOrBlank() || currentEngine != engine) return false
        return when (engine) {
            SpeechEngine.ANDROID -> utteranceId == currentAndroidUtteranceId
            SpeechEngine.ROKID -> utteranceId == currentRokidUtteranceId
        }
    }

    private fun clearCurrentChunkLocked() {
        currentAndroidUtteranceId = null
        currentRokidUtteranceId = null
        currentChunkText = null
        currentEngine = null
        currentUtteranceStarted = false
    }

    private fun resetChunkProgressLocked() {
        currentChunkIndex = 0
        nextChunkIndex = 0
        currentSpeechChunkCount = 0
    }

    private fun setSpeaking(value: Boolean) {
        if (speaking == value) return
        speaking = value
        post { onSpeakingChanged(value) }
    }

    private fun post(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    companion object {
        private const val StartTimeoutMs = 3_000L
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
    }
}
