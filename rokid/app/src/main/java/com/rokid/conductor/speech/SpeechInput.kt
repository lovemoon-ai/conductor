package com.rokid.conductor.speech

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * Speech recognition for voice-first chat on Rokid Glasses.
 *
 * Uses Android SpeechRecognizer when it dispatches correctly, and falls back to
 * Conductor's own recorder/transcription path when the glasses firmware does
 * not call the app-local RecognitionService.
 */
class SpeechInput(
    context: Context,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onError: (String) -> Unit,
    private val onReady: () -> Unit = {},
    private val onBeginning: () -> Unit = {},
    private val onEnd: () -> Unit = {},
) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PrefsName, Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val directScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var recognizer: SpeechRecognizer? = null
    private var directTranscriber: ConductorSpeechTranscriber? = null
    private var fallbackRunnable: Runnable? = null
    private var activeSession = 0
    private var recognizerReady = false
    private var sessionStartedAtMs = 0L

    var available: Boolean = isAvailable(appContext)
        private set
    @Volatile var listening: Boolean = false
        private set

    fun start() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { start() }
            return
        }
        if (listening) return
        if (!isAvailable(appContext)) {
            available = false
            onError("设备不支持语音识别")
            return
        }

        available = true
        activeSession += 1
        val session = activeSession
        sessionStartedAtMs = SystemClock.elapsedRealtime()
        recognizerReady = false
        listening = true
        destroyRecognizer()
        cancelDirectTranscriber()

        if (shouldUseDirectRecognition()) {
            startDirectRecognition(session, "direct speech recognition preferred")
        } else if (hasExternalRecognitionService(appContext)) {
            startPlatformRecognizer(session)
        } else {
            startDirectRecognition(session, "no external platform recognizer")
        }
    }

    /** Stop capturing and let the engine deliver its final result. */
    fun stop() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { stop() }
            return
        }
        if (!listening) return
        if (directTranscriber != null) {
            directTranscriber?.stop()
            return
        }
        if (!recognizerReady) {
            val session = activeSession
            startDirectRecognition(session, "stop requested before platform recognizer became ready")
            directTranscriber?.stop()
            return
        }
        try {
            recognizer?.stopListening()
        } catch (_: Throwable) {
            startDirectRecognition(activeSession, "platform stop failed")
            directTranscriber?.stop()
        }
    }

    fun cancel() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { cancel() }
            return
        }
        listening = false
        activeSession += 1
        cancelFallback()
        cancelDirectTranscriber()
        destroyRecognizer()
        directScope.cancel()
    }

    private fun startPlatformRecognizer(session: Int) {
        try {
            val r = SpeechRecognizer
                .createSpeechRecognizer(appContext)
                .also { recognizer = it }
            r.setRecognitionListener(platformListener(session))
            Log.i(Tag, "starting platform SpeechRecognizer")
            r.startListening(recognizerIntent())
            scheduleFallback(session)
        } catch (e: Throwable) {
            Log.w(Tag, "platform SpeechRecognizer failed, using direct path", e)
            startDirectRecognition(session, "platform start failed")
        }
    }

    private fun startDirectRecognition(session: Int, reason: String) {
        if (session != activeSession || !listening || directTranscriber != null) return
        Log.i(
            Tag,
            "starting direct speech recognition: $reason elapsedMs=${SystemClock.elapsedRealtime() - sessionStartedAtMs}",
        )
        if (reason.startsWith("platform")) {
            rememberDirectRecognition()
        }
        cancelFallback()
        destroyRecognizer()
        val transcriber = ConductorSpeechTranscriber(
            context = appContext,
            client = SpeechBackendConfig.clientFromPrefs(appContext),
            languageTag = preferredLocale().toLanguageTag(),
            callbacks = object : ConductorSpeechTranscriber.Callbacks {
                override fun onReady() {
                    postIfActive(session) {
                        if (!recognizerReady) {
                            recognizerReady = true
                            onReady()
                        }
                    }
                }

                override fun onBeginning() {
                    postIfActive(session) { onBeginning() }
                }

                override fun onEnd() {
                    postIfActive(session) { onEnd() }
                }

                override fun onResult(text: String) {
                    postIfActive(session) { finishWithResult(session, text) }
                }

                override fun onError(error: ConductorSpeechTranscriber.Error) {
                    postIfActive(session) { finishWithError(session, error.toMessage()) }
                }

                override fun onBackendError(message: String) {
                    postIfActive(session) { finishWithError(session, backendErrorMessage(message)) }
                }
            },
            onComplete = { completed ->
                mainHandler.post {
                    if (directTranscriber === completed) directTranscriber = null
                }
            },
        )
        directTranscriber = transcriber
        transcriber.start(directScope)
    }

    private fun platformListener(session: Int): RecognitionListener =
        object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                if (!isPlatformActive(session)) return
                forgetDirectRecognition()
                recognizerReady = true
                cancelFallback()
                onReady()
            }

            override fun onBeginningOfSpeech() {
                if (!isPlatformActive(session)) return
                onBeginning()
            }

            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() {
                if (!isPlatformActive(session)) return
                onEnd()
            }

            override fun onError(error: Int) {
                if (!isPlatformActive(session)) return
                if (!recognizerReady && error.shouldFallbackToDirect()) {
                    startDirectRecognition(session, "platform error before ready: $error")
                    return
                }
                finishWithError(session, errorMessage(error))
            }

            override fun onResults(results: Bundle?) {
                if (!isPlatformActive(session)) return
                val text = firstResult(results)
                finishWithResult(session, text)
            }

            override fun onPartialResults(partialResults: Bundle?) {
                if (!isPlatformActive(session)) return
                val text = firstResult(partialResults)
                if (text.isNotBlank()) onPartial(text)
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}

            private fun firstResult(b: Bundle?): String =
                b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    .orEmpty()
        }

    private fun recognizerIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, preferredLocale().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, preferredLocale().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 0L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3_000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3_000L)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, appContext.packageName)
        }

    private fun scheduleFallback(session: Int) {
        cancelFallback()
        val task = Runnable {
            if (session == activeSession && listening && !recognizerReady && directTranscriber == null) {
                startDirectRecognition(session, "platform recognizer ready timeout")
            }
        }
        fallbackRunnable = task
        mainHandler.postDelayed(task, PlatformReadyTimeoutMs)
    }

    private fun cancelFallback() {
        fallbackRunnable?.let { mainHandler.removeCallbacks(it) }
        fallbackRunnable = null
    }

    private fun finishWithResult(session: Int, text: String) {
        if (!isActive(session)) return
        listening = false
        cleanupAfterFinish()
        if (text.isNotBlank()) onFinal(text) else onError("没有听清，请再说一次")
    }

    private fun finishWithError(session: Int, message: String) {
        if (!isActive(session)) return
        listening = false
        cleanupAfterFinish()
        onError(message)
    }

    private fun cleanupAfterFinish() {
        recognizerReady = false
        cancelFallback()
        destroyRecognizer()
        directTranscriber = null
    }

    private fun cancelDirectTranscriber() {
        directTranscriber?.cancel()
        directTranscriber = null
    }

    private fun destroyRecognizer() {
        try {
            recognizer?.destroy()
        } catch (_: Throwable) {
        }
        recognizer = null
    }

    private fun postIfActive(session: Int, block: () -> Unit) {
        mainHandler.post {
            if (isActive(session)) block()
        }
    }

    private fun isActive(session: Int): Boolean =
        session == activeSession && listening

    private fun isPlatformActive(session: Int): Boolean =
        isActive(session) && directTranscriber == null

    private fun shouldUseDirectRecognition(): Boolean =
        prefs.getBoolean(PrefForceDirectRecognition, false) || isKnownRokidDevice()

    private fun rememberDirectRecognition() {
        prefs.edit().putBoolean(PrefForceDirectRecognition, true).apply()
    }

    private fun forgetDirectRecognition() {
        if (prefs.getBoolean(PrefForceDirectRecognition, false)) {
            prefs.edit().remove(PrefForceDirectRecognition).apply()
        }
    }

    companion object {
        private const val PrefsName = "rokid_conductor"
        private const val PrefForceDirectRecognition = "speech_force_direct_recognition"
        private const val Tag = "ConductorSpeechInput"
        private const val PlatformReadyTimeoutMs = 1_500L
        private const val RecognitionServiceAction = "android.speech.RecognitionService"

        fun isAvailable(context: Context): Boolean =
            hasAppRecognitionService(context) || hasExternalRecognitionService(context)

        @Suppress("DEPRECATION")
        private fun hasAppRecognitionService(context: Context): Boolean {
            val intent = Intent(RecognitionServiceAction).setPackage(context.packageName)
            return context.packageManager.queryIntentServices(intent, 0).any { resolveInfo ->
                val service = resolveInfo.serviceInfo
                service.packageName == context.packageName &&
                    service.name == ConductorRecognitionService::class.java.name
            }
        }

        @Suppress("DEPRECATION")
        private fun hasExternalRecognitionService(context: Context): Boolean {
            val intent = Intent(RecognitionServiceAction)
            return context.packageManager.queryIntentServices(intent, 0).any { resolveInfo ->
                resolveInfo.serviceInfo.packageName != context.packageName
            }
        }

        private fun preferredLocale(): Locale {
            val current = Locale.getDefault()
            return if (current.language.isNullOrBlank()) Locale.SIMPLIFIED_CHINESE else current
        }

        private fun isKnownRokidDevice(): Boolean =
            listOf(
                Build.MANUFACTURER,
                Build.BRAND,
                Build.MODEL,
                Build.DEVICE,
                Build.PRODUCT,
            ).any { value ->
                value?.contains("rokid", ignoreCase = true) == true
            }

        private fun Int.shouldFallbackToDirect(): Boolean = when (this) {
            SpeechRecognizer.ERROR_CLIENT,
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
            SpeechRecognizer.ERROR_SERVER -> true
            else -> false
        }

        private fun ConductorSpeechTranscriber.Error.toMessage(): String = when (this) {
            ConductorSpeechTranscriber.Error.AUDIO -> "麦克风录音失败"
            ConductorSpeechTranscriber.Error.CLIENT -> "请先在眼镜上完成登录"
            ConductorSpeechTranscriber.Error.INSUFFICIENT_PERMISSIONS -> "缺少麦克风权限"
            ConductorSpeechTranscriber.Error.NETWORK -> "语音识别网络错误"
            ConductorSpeechTranscriber.Error.NO_MATCH -> "没有听清，请再说一次"
            ConductorSpeechTranscriber.Error.SPEECH_TIMEOUT -> "没有检测到语音"
        }

        private fun backendErrorMessage(message: String): String {
            val normalized = message.trim()
            return when {
                normalized.isBlank() -> "语音识别服务错误"
                normalized.contains("GLM_API_KEY", ignoreCase = true) ->
                    "语音识别服务未配置 GLM_API_KEY"
                normalized.contains("Speech transcription is not configured", ignoreCase = true) ->
                    "语音识别服务未配置"
                normalized.contains("Transcription failed", ignoreCase = true) ->
                    "语音识别服务调用失败"
                normalized.startsWith("HTTP 404") ->
                    "语音识别后端未发布"
                normalized.startsWith("HTTP 401") || normalized.startsWith("HTTP 403") ->
                    "登录已失效，请重新登录"
                else -> "语音识别服务错误: ${normalized.take(80)}"
            }
        }

        private fun errorMessage(error: Int): String = when (error) {
            SpeechRecognizer.ERROR_AUDIO -> "麦克风录音失败"
            SpeechRecognizer.ERROR_CLIENT -> "语音识别客户端错误"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "缺少麦克风权限"
            SpeechRecognizer.ERROR_NETWORK -> "语音识别网络错误"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "语音识别网络超时"
            SpeechRecognizer.ERROR_NO_MATCH -> "没有听清，请再说一次"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "语音识别忙，请稍后再试"
            SpeechRecognizer.ERROR_SERVER -> "语音识别服务错误"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有检测到语音"
            else -> "语音识别错误 ($error)"
        }
    }
}
