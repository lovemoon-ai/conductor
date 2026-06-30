package com.rokid.conductor.speech

import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class ConductorRecognitionService : RecognitionService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var activeSession: ConductorSpeechTranscriber? = null

    override fun onStartListening(recognizerIntent: android.content.Intent?, listener: Callback) {
        Log.i(Tag, "onStartListening")
        activeSession?.cancel()
        val languageTag = recognizerIntent?.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE)
            ?: Locale.getDefault().toLanguageTag()
        val session = ConductorSpeechTranscriber(
            context = this,
            client = SpeechBackendConfig.clientFromPrefs(this),
            languageTag = languageTag,
            callbacks = object : ConductorSpeechTranscriber.Callbacks {
                override fun onReady() {
                    Log.i(Tag, "ready")
                    listener.safeReady()
                }

                override fun onBeginning() {
                    listener.safeBeginning()
                }

                override fun onRmsChanged(value: Float) {
                    listener.safeRms(value)
                }

                override fun onEnd() {
                    Log.i(Tag, "end")
                    listener.safeEnd()
                }

                override fun onResult(text: String) {
                    Log.i(Tag, "result chars=${text.length}")
                    listener.safeResults(text)
                }

                override fun onError(error: ConductorSpeechTranscriber.Error) {
                    Log.w(Tag, "error=$error")
                    listener.safeError(error.toRecognizerError())
                }

                override fun onBackendError(message: String) {
                    Log.w(Tag, "backendError=$message")
                    listener.safeError(SpeechRecognizer.ERROR_SERVER)
                }
            },
            onComplete = { completed ->
                if (activeSession === completed) activeSession = null
            },
        )
        activeSession = session
        session.start(scope)
    }

    override fun onStopListening(listener: Callback) {
        Log.i(Tag, "onStopListening")
        activeSession?.stop()
    }

    override fun onCancel(listener: Callback) {
        Log.i(Tag, "onCancel")
        activeSession?.cancel()
        activeSession = null
    }

    override fun onDestroy() {
        activeSession?.cancel()
        activeSession = null
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val Tag = "ConductorRecognitionService"

        fun componentName(context: Context): ComponentName =
            ComponentName(context, ConductorRecognitionService::class.java)

        private fun ConductorSpeechTranscriber.Error.toRecognizerError(): Int = when (this) {
            ConductorSpeechTranscriber.Error.INSUFFICIENT_PERMISSIONS ->
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS
            ConductorSpeechTranscriber.Error.CLIENT -> SpeechRecognizer.ERROR_CLIENT
            ConductorSpeechTranscriber.Error.AUDIO -> SpeechRecognizer.ERROR_AUDIO
            ConductorSpeechTranscriber.Error.NETWORK -> SpeechRecognizer.ERROR_NETWORK
            ConductorSpeechTranscriber.Error.NO_MATCH -> SpeechRecognizer.ERROR_NO_MATCH
            ConductorSpeechTranscriber.Error.SPEECH_TIMEOUT -> SpeechRecognizer.ERROR_SPEECH_TIMEOUT
        }

        private fun Callback.safeReady() {
            safe { readyForSpeech(Bundle.EMPTY) }
        }

        private fun Callback.safeBeginning() {
            safe { beginningOfSpeech() }
        }

        private fun Callback.safeEnd() {
            safe { endOfSpeech() }
        }

        private fun Callback.safeRms(value: Float) {
            safe { rmsChanged(value) }
        }

        private fun Callback.safeResults(text: String) {
            val bundle = Bundle().apply {
                putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf(text))
            }
            safe { results(bundle) }
        }

        private fun Callback.safeError(error: Int) {
            safe { error(error) }
        }

        private fun Callback.safe(block: Callback.() -> Unit) {
            try {
                block()
            } catch (_: Throwable) {
            }
        }
    }
}
