package com.rokid.conductor.speech

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import com.rokid.conductor.net.ConductorException
import com.rokid.conductor.net.ConductorClient
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

internal class ConductorSpeechTranscriber(
    context: Context,
    private val client: ConductorClient,
    private val languageTag: String,
    private val callbacks: Callbacks,
    private val onComplete: (ConductorSpeechTranscriber) -> Unit = {},
) {
    private val appContext = context.applicationContext
    private val stopRequested = AtomicBoolean(false)
    private val canceled = AtomicBoolean(false)
    private var job: Job? = null

    fun start(scope: CoroutineScope) {
        job = scope.launch {
            try {
                recordAndTranscribe()
            } finally {
                onComplete(this@ConductorSpeechTranscriber)
            }
        }
    }

    fun stop() {
        stopRequested.set(true)
    }

    fun cancel() {
        canceled.set(true)
        stopRequested.set(true)
        job?.cancel()
    }

    @SuppressLint("MissingPermission")
    private suspend fun recordAndTranscribe() {
        if (appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(Tag, "record audio permission missing")
            callbacks.onError(Error.INSUFFICIENT_PERMISSIONS)
            return
        }
        if (client.token.isNullOrBlank()) {
            Log.w(Tag, "auth token missing")
            callbacks.onError(Error.CLIENT)
            return
        }

        val minBufferSize = AudioRecord.getMinBufferSize(
            SampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBufferSize <= 0) {
            Log.w(Tag, "invalid min buffer size: $minBufferSize")
            callbacks.onError(Error.AUDIO)
            return
        }

        val readBuffer = ShortArray((minBufferSize / 2).coerceAtLeast(1024))
        val pcm = ByteArrayOutputStream(SampleRate * 2 * 4)
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBufferSize * 2,
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            Log.w(Tag, "AudioRecord initialization failed")
            callbacks.onError(Error.AUDIO)
            return
        }

        var speechStarted = false
        var lastSpeechAt = 0L
        var maxRms = 0.0
        var ambientRms = InitialAmbientRms
        val startedAt = SystemClock.elapsedRealtime()
        try {
            recorder.startRecording()
            if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                Log.w(Tag, "AudioRecord did not enter recording state")
                callbacks.onError(Error.AUDIO)
                return
            }
            Log.i(Tag, "recorder ready")
            callbacks.onReady()
            while (!canceled.get()) {
                val now = SystemClock.elapsedRealtime()
                if (now - startedAt >= MaxRecordingMs) break
                if (stopRequested.get() && now - startedAt >= MinRecordingMs) break

                val read = recorder.read(readBuffer, 0, readBuffer.size)
                if (read <= 0) continue
                appendPcm(pcm, readBuffer, read)
                val rms = rms(readBuffer, read)
                if (rms > maxRms) maxRms = rms
                callbacks.onRmsChanged(rms.toDb())

                val startThreshold = speechStartThreshold(ambientRms)
                val endThreshold = speechEndThreshold(ambientRms)
                if (rms >= startThreshold) {
                    if (!speechStarted) {
                        speechStarted = true
                        callbacks.onBeginning()
                    }
                    lastSpeechAt = now
                } else if (!speechStarted) {
                    ambientRms = smoothAmbientRms(ambientRms, rms)
                } else if (rms >= endThreshold) {
                    lastSpeechAt = now
                } else if (
                    speechStarted &&
                    !stopRequested.get() &&
                    now - lastSpeechAt >= AutoSilenceMs &&
                    now - startedAt >= MinRecordingMs
                ) {
                    break
                }
            }
        } catch (_: Throwable) {
            Log.w(Tag, "AudioRecord capture failed")
            callbacks.onError(Error.AUDIO)
            return
        } finally {
            try {
                recorder.stop()
            } catch (_: Throwable) {
            }
            recorder.release()
        }

        if (canceled.get()) return
        callbacks.onEnd()
        val pcmBytes = pcm.toByteArray()
        Log.i(Tag, "captured pcm bytes=${pcmBytes.size} maxRms=${maxRms.toInt()}")
        if (pcmBytes.size < MinPcmBytes) {
            callbacks.onError(Error.SPEECH_TIMEOUT)
            return
        }

        try {
            val text = client.transcribeSpeech(pcmToWav(pcmBytes), languageTag)
            if (text.isBlank()) {
                callbacks.onError(Error.NO_MATCH)
                return
            }
            Log.i(Tag, "transcription result chars=${text.length}")
            callbacks.onResult(text)
        } catch (e: ConductorException) {
            val message = e.message?.trim().orEmpty()
            Log.w(Tag, "transcription backend error: $message")
            if (message.contains("No speech recognized", ignoreCase = true)) {
                callbacks.onError(Error.NO_MATCH)
            } else {
                callbacks.onBackendError(message)
            }
        } catch (_: Throwable) {
            Log.w(Tag, "transcription request failed")
            callbacks.onError(Error.NETWORK)
        }
    }

    interface Callbacks {
        fun onReady() {}
        fun onBeginning() {}
        fun onRmsChanged(value: Float) {}
        fun onEnd() {}
        fun onResult(text: String)
        fun onError(error: Error)
        fun onBackendError(message: String) {
            onError(Error.NETWORK)
        }
    }

    enum class Error {
        INSUFFICIENT_PERMISSIONS,
        CLIENT,
        AUDIO,
        NETWORK,
        NO_MATCH,
        SPEECH_TIMEOUT,
    }

    companion object {
        private const val SampleRate = 16_000
        private const val MaxRecordingMs = 8_000L
        private const val MinRecordingMs = 700L
        private const val AutoSilenceMs = 1_100L
        private const val InitialAmbientRms = 45.0
        private const val AmbientSmoothing = 0.9
        private const val SpeechStartNoiseMultiplier = 2.8
        private const val SpeechEndNoiseMultiplier = 1.6
        private const val MinSpeechStartRms = 140.0
        private const val MaxSpeechStartRms = 320.0
        private const val MinSpeechEndRms = 80.0
        private const val MaxSpeechEndRms = 180.0
        private const val MinPcmBytes = SampleRate * 2 / 2
        private const val Tag = "ConductorSpeechTranscriber"

        private fun appendPcm(out: ByteArrayOutputStream, data: ShortArray, count: Int) {
            for (i in 0 until count) {
                val value = data[i].toInt()
                out.write(value and 0xff)
                out.write((value shr 8) and 0xff)
            }
        }

        private fun rms(data: ShortArray, count: Int): Double {
            if (count <= 0) return 0.0
            var sum = 0.0
            for (i in 0 until count) {
                val value = data[i].toDouble()
                sum += value * value
            }
            return kotlin.math.sqrt(sum / count)
        }

        private fun smoothAmbientRms(previous: Double, sample: Double): Double =
            previous * AmbientSmoothing + sample * (1.0 - AmbientSmoothing)

        private fun speechStartThreshold(ambientRms: Double): Double =
            (ambientRms * SpeechStartNoiseMultiplier)
                .coerceIn(MinSpeechStartRms, MaxSpeechStartRms)

        private fun speechEndThreshold(ambientRms: Double): Double =
            (ambientRms * SpeechEndNoiseMultiplier)
                .coerceIn(MinSpeechEndRms, MaxSpeechEndRms)

        private fun Double.toDb(): Float {
            if (this <= 1.0) return -2.0f
            return (20.0 * kotlin.math.log10(this / Short.MAX_VALUE) + 60.0)
                .toFloat()
                .coerceIn(-2.0f, 10.0f)
        }

        private fun pcmToWav(pcm: ByteArray): ByteArray {
            val out = ByteArrayOutputStream(pcm.size + 44)
            val byteRate = SampleRate * 2
            out.writeAscii("RIFF")
            out.writeLe32(pcm.size + 36)
            out.writeAscii("WAVE")
            out.writeAscii("fmt ")
            out.writeLe32(16)
            out.writeLe16(1)
            out.writeLe16(1)
            out.writeLe32(SampleRate)
            out.writeLe32(byteRate)
            out.writeLe16(2)
            out.writeLe16(16)
            out.writeAscii("data")
            out.writeLe32(pcm.size)
            out.write(pcm)
            return out.toByteArray()
        }

        private fun ByteArrayOutputStream.writeAscii(value: String) {
            write(value.toByteArray(Charsets.US_ASCII))
        }

        private fun ByteArrayOutputStream.writeLe16(value: Int) {
            write(value and 0xff)
            write((value shr 8) and 0xff)
        }

        private fun ByteArrayOutputStream.writeLe32(value: Int) {
            write(value and 0xff)
            write((value shr 8) and 0xff)
            write((value shr 16) and 0xff)
            write((value shr 24) and 0xff)
        }
    }
}
