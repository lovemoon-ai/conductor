package com.rokid.conductor.glasses

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Phone-side Text-To-Speech used to read AI replies aloud. With the glasses set as the
 * communication audio device (see [GlassesManager.openAiChat] → setCommunicationDevice), the
 * audio is routed to the glasses speaker.
 *
 * Utterances are queued (QUEUE_ADD) so replies are spoken back-to-back in order; [onDone] fires
 * after the last queued utterance so the caller can resume listening for the next turn.
 */
class TtsManager(
    context: Context,
    private val onDone: () -> Unit = {},
) {
    private var ready = false
    private var lastUtteranceId: String = ""

    private val tts: TextToSpeech = TextToSpeech(context.applicationContext, ::onInit)

    private fun onInit(status: Int) {
        ready = status == TextToSpeech.SUCCESS
        if (!ready) {
            Log.w(TAG, "TTS init failed: $status")
            return
        }
        try {
            tts.language = Locale.SIMPLIFIED_CHINESE
        } catch (e: Throwable) {
            Log.w(TAG, "set language failed: ${e.message}")
        }
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) {
                if (utteranceId == lastUtteranceId) onDone()
            }
            @Deprecated("deprecated in API level 21")
            override fun onError(utteranceId: String?) {}
            override fun onError(utteranceId: String?, errorCode: Int) {}
        })
    }

    /** Queue [text] to be spoken after anything already queued. */
    fun speak(text: String) {
        if (!ready || text.isBlank()) return
        val id = "u${System.identityHashCode(text)}_${text.length}"
        lastUtteranceId = id
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, id)
    }

    /** Stop any in-progress and queued speech. */
    fun stop() {
        try { tts.stop() } catch (_: Throwable) {}
    }

    fun release() {
        try { tts.stop(); tts.shutdown() } catch (_: Throwable) {}
    }

    companion object {
        private const val TAG = "TtsManager"
    }
}
