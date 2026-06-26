package com.rokid.conductor.speech

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * Phone-side speech recognition. With the glasses connected as the communication audio device
 * (see GlassesManager.setCommunicationDevice), this captures the glasses microphone.
 *
 * Must be created and called on the main thread (SpeechRecognizer requirement).
 */
class SpeechInput(
    private val context: Context,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    private var recognizer: SpeechRecognizer? = null
    var available: Boolean = SpeechRecognizer.isRecognitionAvailable(context)
        private set
    @Volatile var listening: Boolean = false
        private set

    fun start() {
        if (listening) return
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            available = false
            onError("设备不支持语音识别")
            return
        }
        val r = SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        r.setRecognitionListener(listener)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        }
        listening = true
        try {
            r.startListening(intent)
        } catch (e: Throwable) {
            listening = false
            onError("无法启动语音识别: ${e.message}")
        }
    }

    /** Stop capturing and let the engine deliver its final result. */
    fun stop() {
        try { recognizer?.stopListening() } catch (_: Throwable) {}
    }

    fun cancel() {
        listening = false
        try { recognizer?.cancel() } catch (_: Throwable) {}
        destroy()
    }

    private fun destroy() {
        try { recognizer?.destroy() } catch (_: Throwable) {}
        recognizer = null
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}

        override fun onError(error: Int) {
            listening = false
            destroy()
            // No-match / timeout are common and not worth surfacing loudly.
            if (error != SpeechRecognizer.ERROR_NO_MATCH &&
                error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            ) {
                onError("语音识别错误 ($error)")
            } else {
                onError("")
            }
        }

        override fun onResults(results: Bundle?) {
            listening = false
            val text = firstResult(results)
            destroy()
            if (text.isNotBlank()) onFinal(text)
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val text = firstResult(partialResults)
            if (text.isNotBlank()) onPartial(text)
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}

        private fun firstResult(b: Bundle?): String =
            b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
    }

    companion object {
        private const val TAG = "SpeechInput"
    }
}
