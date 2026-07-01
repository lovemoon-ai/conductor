package com.rokid.conductor.speech

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.SystemClock
import android.util.Log
import com.rokid.conductor.net.ConductorException
import com.rokid.conductor.net.ConductorClient
import com.rokid.conductor.net.SpeechStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.async
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

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
                recordAndTranscribe(this)
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
    private suspend fun recordAndTranscribe(scope: CoroutineScope) {
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
        val recorderHandle = createRecorder(minBufferSize)
        if (recorderHandle == null) {
            Log.w(Tag, "AudioRecord initialization failed")
            callbacks.onError(Error.AUDIO)
            return
        }
        val recorder = recorderHandle.recorder
        val effects = AudioEffects.attach(recorder.audioSessionId)
        val streamDeferred = scope.async {
            runCatching { client.openSpeechStream(languageTag, SampleRate) }
                .onFailure { Log.i(Tag, "speech stream unavailable: ${it.message}") }
                .getOrNull()
        }

        var speechStarted = false
        var speechStartedAt = 0L
        var lastSpeechAt = 0L
        var currentSpeechRunStartedAt = 0L
        var manualStopRequired = false
        var maxRms = 0.0
        var ambientRms = InitialAmbientRms
        var speechStream: SpeechStream? = null
        var streamUnavailable = false
        val startedAt = SystemClock.elapsedRealtime()
        val preRoll = ArrayDeque<ShortArray>()
        var preRollSamples = 0

        fun disableStream(reason: String) {
            if (!streamUnavailable) {
                Log.i(Tag, "speech stream disabled: $reason")
            }
            streamUnavailable = true
            speechStream?.cancel()
            speechStream = null
            streamDeferred.cancel()
        }

        fun sendPcmToStream(bytes: ByteArray) {
            val stream = speechStream ?: return
            if (!stream.sendPcm(bytes)) {
                disableStream("send failed")
            }
        }

        fun appendAndStream(chunk: ShortArray, count: Int = chunk.size) {
            val bytes = appendPcm(pcm, chunk, count)
            sendPcmToStream(bytes)
        }

        suspend fun attachReadyStream() {
            if (speechStream != null || streamUnavailable || !streamDeferred.isCompleted) return
            val stream = runCatching { streamDeferred.await() }.getOrNull()
            if (stream == null) {
                streamUnavailable = true
                return
            }
            speechStream = stream
            val pending = pcm.toByteArray()
            if (pending.isNotEmpty() && !stream.sendPcm(pending)) {
                disableStream("catch-up send failed")
                return
            }
            Log.i(Tag, "speech stream ready bufferedBytes=${pending.size}")
        }

        suspend fun attachStreamBeforeFinish() {
            if (speechStream != null || streamUnavailable) return
            val stream = runCatching {
                withTimeout(StreamFinishAttachWaitMs) {
                    streamDeferred.await()
                }
            }.getOrNull()
            if (stream == null) {
                streamDeferred.cancel()
                streamUnavailable = true
                return
            }
            speechStream = stream
            val pending = pcm.toByteArray()
            if (pending.isNotEmpty() && !stream.sendPcm(pending)) {
                disableStream("finish catch-up send failed")
                return
            }
            Log.i(Tag, "speech stream attached before finish bufferedBytes=${pending.size}")
        }

        fun rememberPreRoll(chunk: ShortArray) {
            preRoll.addLast(chunk)
            preRollSamples += chunk.size
            while (preRollSamples > MaxPreRollSamples && preRoll.isNotEmpty()) {
                preRollSamples -= preRoll.removeFirst().size
            }
        }

        fun appendPreRoll() {
            while (preRoll.isNotEmpty()) {
                val chunk = preRoll.removeFirst()
                appendAndStream(chunk)
            }
            preRollSamples = 0
        }

        try {
            recorder.startRecording()
            if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                disableStream("recorder not recording")
                Log.w(Tag, "AudioRecord did not enter recording state")
                callbacks.onError(Error.AUDIO)
                return
            }
            Log.i(
                Tag,
                "recorder ready source=${sourceName(recorderHandle.source)} ns=${effects.noiseSuppressionEnabled}",
            )
            callbacks.onReady()
            while (!canceled.get()) {
                val now = SystemClock.elapsedRealtime()
                if (
                    shouldStopCapture(
                        now = now,
                        captureStartedAt = startedAt,
                        speechStarted = speechStarted,
                        speechStartedAt = speechStartedAt,
                        lastSpeechAt = lastSpeechAt,
                        manualStopRequired = manualStopRequired,
                        stopRequested = stopRequested.get(),
                    )
                ) {
                    break
                }

                val read = recorder.read(readBuffer, 0, readBuffer.size)
                if (read <= 0) continue
                attachReadyStream()
                val chunk = readBuffer.copyOf(read)
                val rms = rms(chunk, read)
                if (rms > maxRms) maxRms = rms
                callbacks.onRmsChanged(rms.toDb())

                val startThreshold = speechStartThreshold(ambientRms)
                val endThreshold = speechEndThreshold(ambientRms)

                fun rememberSpeechActivity() {
                    if (
                        currentSpeechRunStartedAt == 0L ||
                        now - lastSpeechAt > SpeechRunResetSilenceMs
                    ) {
                        currentSpeechRunStartedAt = now
                    }
                    lastSpeechAt = now
                    if (
                        !manualStopRequired &&
                        shouldRequireManualStop(now, currentSpeechRunStartedAt)
                    ) {
                        manualStopRequired = true
                        Log.i(Tag, "long speech detected; waiting for manual stop or long silence")
                    }
                }

                if (rms >= startThreshold) {
                    if (!speechStarted) {
                        speechStarted = true
                        speechStartedAt = now
                        appendPreRoll()
                        callbacks.onBeginning()
                    }
                    appendAndStream(chunk)
                    rememberSpeechActivity()
                } else if (!speechStarted) {
                    rememberPreRoll(chunk)
                    ambientRms = smoothAmbientRms(ambientRms, rms)
                } else {
                    appendAndStream(chunk)
                    if (rms >= endThreshold) {
                        rememberSpeechActivity()
                    }
                }
            }
        } catch (_: Throwable) {
            disableStream("capture failed")
            Log.w(Tag, "AudioRecord capture failed")
            callbacks.onError(Error.AUDIO)
            return
        } finally {
            try {
                recorder.stop()
            } catch (_: Throwable) {
            }
            recorder.release()
            effects.release()
        }

        if (canceled.get()) {
            disableStream("canceled")
            return
        }
        if (!speechStarted) {
            disableStream("no speech")
            Log.i(Tag, "no speech detected maxRms=${maxRms.toInt()}")
            callbacks.onError(Error.SPEECH_TIMEOUT)
            return
        }
        callbacks.onEnd()
        val pcmBytes = pcm.toByteArray()
        Log.i(
            Tag,
            "captured pcm bytes=${pcmBytes.size} maxRms=${maxRms.toInt()} speechMs=${SystemClock.elapsedRealtime() - speechStartedAt}",
        )
        if (pcmBytes.size < MinPcmBytes) {
            disableStream("speech too short")
            callbacks.onError(Error.SPEECH_TIMEOUT)
            return
        }

        attachStreamBeforeFinish()
        val stream = speechStream
        if (stream != null) {
            try {
                val requestStartedAt = SystemClock.elapsedRealtime()
                val text = stream.finish()
                if (text.isBlank()) {
                    callbacks.onError(Error.NO_MATCH)
                    return
                }
                Log.i(
                    Tag,
                    "stream transcription result chars=${text.length} language=$languageTag requestMs=${SystemClock.elapsedRealtime() - requestStartedAt}",
                )
                callbacks.onResult(text)
                return
            } catch (e: ConductorException) {
                val message = e.message?.trim().orEmpty()
                if (message.contains("No speech recognized", ignoreCase = true)) {
                    callbacks.onError(Error.NO_MATCH)
                    return
                }
                if (message.contains("rate limit", ignoreCase = true)) {
                    callbacks.onBackendError(message)
                    return
                }
                Log.w(Tag, "speech stream failed, falling back to REST: $message")
            } catch (t: Throwable) {
                Log.w(Tag, "speech stream failed, falling back to REST: ${t.message}")
            }
        }

        try {
            val requestStartedAt = SystemClock.elapsedRealtime()
            val text = client.transcribeSpeech(pcmToWav(pcmBytes), languageTag)
            if (text.isBlank()) {
                callbacks.onError(Error.NO_MATCH)
                return
            }
            Log.i(
                Tag,
                "transcription result chars=${text.length} language=$languageTag requestMs=${SystemClock.elapsedRealtime() - requestStartedAt}",
            )
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
        private const val MinRecordingMs = 700L
        private const val MinSpeechMs = 280L
        private const val ShortUtteranceAutoSilenceMs = 3_000L
        private const val LongSpeechManualOnlyMs = 10_000L
        private const val LongNoSpeechTimeoutMs = 15_000L
        private const val InitialNoSpeechTimeoutMs = 15_000L
        private const val SpeechRunResetSilenceMs = 700L
        private const val PreRollMs = 320
        private const val StreamFinishAttachWaitMs = 250L
        private const val InitialAmbientRms = 45.0
        private const val AmbientSmoothing = 0.9
        private const val SpeechStartNoiseMultiplier = 2.2
        private const val SpeechEndNoiseMultiplier = 1.35
        private const val MinSpeechStartRms = 85.0
        private const val MaxSpeechStartRms = 260.0
        private const val MinSpeechEndRms = 45.0
        private const val MaxSpeechEndRms = 140.0
        private const val MaxPreRollSamples = SampleRate * PreRollMs / 1000
        private const val MinPcmBytes = SampleRate * 2 / 3
        private const val Tag = "ConductorSpeechTranscriber"

        internal fun shouldRequireManualStop(now: Long, currentSpeechRunStartedAt: Long): Boolean =
            currentSpeechRunStartedAt > 0L &&
                now - currentSpeechRunStartedAt >= LongSpeechManualOnlyMs

        internal fun shouldStopCapture(
            now: Long,
            captureStartedAt: Long,
            speechStarted: Boolean,
            speechStartedAt: Long,
            lastSpeechAt: Long,
            manualStopRequired: Boolean,
            stopRequested: Boolean,
        ): Boolean {
            if (stopRequested && now - captureStartedAt >= MinRecordingMs) {
                return true
            }
            if (!speechStarted) {
                return now - captureStartedAt >= InitialNoSpeechTimeoutMs
            }
            val silenceMs = now - lastSpeechAt
            if (manualStopRequired) {
                return silenceMs >= LongNoSpeechTimeoutMs
            }
            return silenceMs >= ShortUtteranceAutoSilenceMs &&
                now - captureStartedAt >= MinRecordingMs &&
                now - speechStartedAt >= MinSpeechMs
        }

        private data class RecorderHandle(
            val recorder: AudioRecord,
            val source: Int,
        )

        @SuppressLint("MissingPermission")
        private fun createRecorder(minBufferSize: Int): RecorderHandle? {
            // RG glasses return silent PCM for VOICE_RECOGNITION on tested firmware.
            // Prefer the generic mic path and keep processed sources as fallback only.
            val sources = listOf(
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.DEFAULT,
            ).distinct()
            for (source in sources) {
                val recorder = try {
                    AudioRecord(
                        source,
                        SampleRate,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        minBufferSize * 2,
                    )
                } catch (_: Throwable) {
                    null
                } ?: continue
                if (recorder.state == AudioRecord.STATE_INITIALIZED) {
                    return RecorderHandle(recorder, source)
                }
                recorder.release()
            }
            return null
        }

        private fun sourceName(source: Int): String = when (source) {
            MediaRecorder.AudioSource.VOICE_RECOGNITION -> "VOICE_RECOGNITION"
            MediaRecorder.AudioSource.MIC -> "MIC"
            MediaRecorder.AudioSource.DEFAULT -> "DEFAULT"
            else -> source.toString()
        }

        private class AudioEffects private constructor(
            private val noiseSuppressor: NoiseSuppressor?,
            private val automaticGainControl: AutomaticGainControl?,
            private val acousticEchoCanceler: AcousticEchoCanceler?,
        ) {
            val noiseSuppressionEnabled: Boolean = noiseSuppressor?.enabled == true

            fun release() {
                try {
                    noiseSuppressor?.release()
                } catch (_: Throwable) {
                }
                try {
                    automaticGainControl?.release()
                } catch (_: Throwable) {
                }
                try {
                    acousticEchoCanceler?.release()
                } catch (_: Throwable) {
                }
            }

            companion object {
                fun attach(audioSessionId: Int): AudioEffects {
                    val ns = createNoiseSuppressor(audioSessionId)
                    val agc = createAutomaticGainControl(audioSessionId)
                    val aec = createAcousticEchoCanceler(audioSessionId)
                    return AudioEffects(ns, agc, aec)
                }

                private fun createNoiseSuppressor(audioSessionId: Int): NoiseSuppressor? =
                    createEffect(NoiseSuppressor.isAvailable()) {
                        NoiseSuppressor.create(audioSessionId)
                    }

                private fun createAutomaticGainControl(audioSessionId: Int): AutomaticGainControl? =
                    createEffect(AutomaticGainControl.isAvailable()) {
                        AutomaticGainControl.create(audioSessionId)
                    }

                private fun createAcousticEchoCanceler(audioSessionId: Int): AcousticEchoCanceler? =
                    createEffect(AcousticEchoCanceler.isAvailable()) {
                        AcousticEchoCanceler.create(audioSessionId)
                    }

                private fun <T> createEffect(
                    available: Boolean,
                    create: () -> T?,
                ): T? {
                    if (!available) return null
                    return try {
                        create()?.also { effect ->
                            when (effect) {
                                is NoiseSuppressor -> effect.enabled = true
                                is AutomaticGainControl -> effect.enabled = true
                                is AcousticEchoCanceler -> effect.enabled = true
                            }
                        }
                    } catch (_: Throwable) {
                        null
                    }
                }
            }
        }

        private fun appendPcm(out: ByteArrayOutputStream, data: ShortArray, count: Int): ByteArray {
            val bytes = shortsToPcmBytes(data, count)
            out.write(bytes)
            return bytes
        }

        private fun shortsToPcmBytes(data: ShortArray, count: Int): ByteArray {
            val bytes = ByteArray(count * 2)
            for (i in 0 until count) {
                val value = data[i].toInt()
                val offset = i * 2
                bytes[offset] = (value and 0xff).toByte()
                bytes[offset + 1] = ((value shr 8) and 0xff).toByte()
            }
            return bytes
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
