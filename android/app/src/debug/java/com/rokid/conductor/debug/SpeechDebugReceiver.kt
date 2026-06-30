package com.rokid.conductor.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.rokid.conductor.speech.SpeechInput
import com.rokid.conductor.speech.SpeechOutput

class SpeechDebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "com.rokid.conductor.DEBUG_RECOGNIZE") {
            SpeechDebugHarness.recognize(
                context.applicationContext,
                intent.getLongExtra("duration_ms", 3_000L),
            )
            return
        }
        val text = intent.getStringExtra("text")?.takeIf { it.isNotBlank() }
            ?: "Conductor 语音朗读测试"
        SpeechDebugHarness.speak(context.applicationContext, text)
    }
}

private object SpeechDebugHarness {
    private const val Tag = "ConductorSpeechDebug"
    private val handler = Handler(Looper.getMainLooper())
    private var output: SpeechOutput? = null
    private var input: SpeechInput? = null
    private var pendingText: String? = null
    private var started = false

    fun speak(context: Context, text: String) {
        handler.post {
            shutdown()
            pendingText = text
            started = false
            Log.i(Tag, "debug speak requested")
            output = SpeechOutput(
                context = context,
                onAvailability = { available, status ->
                    Log.i(Tag, "availability available=$available status=$status")
                    if (available) speakPending()
                },
                onSpeakingChanged = { speaking ->
                    Log.i(Tag, "speaking=$speaking")
                    if (speaking) {
                        started = true
                    } else if (started) {
                        shutdown()
                    }
                },
                onError = { message ->
                    Log.e(Tag, "error=$message")
                    shutdown()
                },
            )
            handler.postDelayed({ speakPending() }, 1500L)
            handler.postDelayed({ shutdown() }, 12_000L)
        }
    }

    fun recognize(context: Context, durationMs: Long) {
        handler.post {
            shutdown()
            Log.i(Tag, "debug recognize requested")
            input = SpeechInput(
                context = context,
                onPartial = { partial -> Log.i(Tag, "recognize partial=$partial") },
                onFinal = { final ->
                    Log.i(Tag, "recognize final=$final")
                    shutdown()
                },
                onError = { message ->
                    Log.e(Tag, "recognize error=$message")
                    shutdown()
                },
                onReady = { Log.i(Tag, "recognize ready") },
                onEnd = { Log.i(Tag, "recognize end") },
            )
            input?.start()
            handler.postDelayed({ input?.stop() }, durationMs.coerceIn(700L, 8_000L))
            handler.postDelayed({ shutdown() }, 20_000L)
        }
    }

    private fun speakPending() {
        val text = pendingText ?: return
        val speech = output ?: return
        if (!speech.ready && !speech.available) return
        pendingText = null
        Log.i(Tag, "calling SpeechOutput.speak")
        if (!speech.speak(text)) {
            shutdown()
        }
    }

    private fun shutdown() {
        pendingText = null
        started = false
        output?.shutdown()
        output = null
        input?.cancel()
        input = null
    }
}
