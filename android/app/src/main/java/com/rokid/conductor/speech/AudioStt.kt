package com.rokid.conductor.speech

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.sqrt

/**
 * Hands-free speech-to-text via cloud ASR (Zhipu GLM-ASR-2512).
 *
 * Records 16 kHz mono PCM from the (glasses) mic and uses a simple energy-based VAD to detect the
 * end of an utterance: once speech is heard and then a trailing silence of [SILENCE_MS] passes, it
 * auto-finalizes — no touchpad/button needed. The PCM is wrapped as WAV (GLM-ASR rejects m4a),
 * uploaded, and the text delivered via [onFinal]. [stop] forces an immediate endpoint (barge-in).
 *
 * Android's SpeechRecognizer is unusable here (this device has no RecognitionService), hence cloud
 * ASR; the glasses AI-key (a long-press) is unreliable in CustomView mode, hence VAD auto-endpoint.
 */
class AudioStt(
    private val context: Context,
    private val onFinal: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    @Volatile var listening: Boolean = false
        private set
    @Volatile private var finalized: Boolean = false

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val pcm = ByteArrayOutputStream()
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null

    @SuppressLint("MissingPermission")
    fun start() {
        if (listening) return
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuf <= 0) { onError("录音不可用"); return }
        // MIC (the default phone mic, routed to the glasses mic by setCommunicationDevice) is what
        // actually captures audio on this device — VOICE_COMMUNICATION returns silence here.
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, CHANNEL, ENCODING, minBuf * 2)
        } catch (e: Throwable) { onError("录音启动失败"); return }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release(); onError("录音初始化失败"); return
        }
        enableEffects(rec.audioSessionId)
        synchronized(pcm) { pcm.reset() }
        record = rec
        finalized = false
        listening = true
        rec.startRecording()
        thread = Thread { recordLoop(rec, maxOf(minBuf, 1280)) }.also { it.start() }
    }

    private fun recordLoop(rec: AudioRecord, bufSize: Int) {
        val buf = ByteArray(bufSize)
        var speechStarted = false
        var silenceBytes = 0
        var totalBytes = 0
        val maxBytes = SAMPLE_RATE * 2 * MAX_SECONDS
        val silenceLimit = SAMPLE_RATE * 2 * SILENCE_MS / 1000
        val noSpeechLimit = SAMPLE_RATE * 2 * NO_SPEECH_MS / 1000
        var endpoint = false
        while (listening) {
            val n = rec.read(buf, 0, buf.size)
            if (n <= 0) { if (n < 0) break else continue }
            synchronized(pcm) { pcm.write(buf, 0, n) }
            totalBytes += n
            val level = rms(buf, n)
            if (level > SPEECH_RMS) {
                speechStarted = true
                silenceBytes = 0
            } else if (speechStarted && level < SILENCE_RMS) {
                silenceBytes += n
                if (silenceBytes >= silenceLimit) { endpoint = true; break } // end of utterance
            }
            if (totalBytes >= maxBytes) { endpoint = true; break } // hard cap
            if (!speechStarted && totalBytes >= noSpeechLimit) break // nobody spoke
        }
        finalizeUtterance(speechStarted && endpoint)
    }

    /** Stop, build WAV, upload. Runs on the recording thread (or none, if externally stopped). */
    @Synchronized
    private fun finalizeUtterance(hadSpeech: Boolean) {
        if (finalized) return
        finalized = true
        listening = false
        try { record?.stop() } catch (_: Throwable) {}
        try { record?.release() } catch (_: Throwable) {}
        record = null
        releaseEffects()
        val data = synchronized(pcm) { pcm.toByteArray() }
        if (!hadSpeech || data.size < MIN_BYTES) { onError(""); return }
        // Already on a worker thread when called from recordLoop; spawn one otherwise.
        if (Thread.currentThread() == thread) transcribe(wavFromPcm(data))
        else Thread { transcribe(wavFromPcm(data)) }.start()
    }

    /** Force an immediate endpoint (e.g. a manual long-press) — the loop exits and finalizes. */
    fun stop() {
        if (!listening) return
        listening = false // recordLoop will exit and finalize with whatever was captured
    }

    fun cancel() {
        listening = false
        finalized = true
        try { record?.stop() } catch (_: Throwable) {}
        try { record?.release() } catch (_: Throwable) {}
        record = null
        releaseEffects()
        synchronized(pcm) { pcm.reset() }
    }

    private fun enableEffects(sessionId: Int) {
        try {
            if (AcousticEchoCanceler.isAvailable()) {
                aec = AcousticEchoCanceler.create(sessionId)?.also { it.enabled = true }
            }
        } catch (e: Throwable) { Log.w(TAG, "AEC failed: ${e.message}") }
        try {
            if (NoiseSuppressor.isAvailable()) {
                ns = NoiseSuppressor.create(sessionId)?.also { it.enabled = true }
            }
        } catch (e: Throwable) { Log.w(TAG, "NS failed: ${e.message}") }
    }

    private fun releaseEffects() {
        try { aec?.release() } catch (_: Throwable) {}
        try { ns?.release() } catch (_: Throwable) {}
        aec = null
        ns = null
    }

    /** Root-mean-square amplitude of a little-endian 16-bit PCM buffer. */
    private fun rms(buf: ByteArray, n: Int): Double {
        var sum = 0.0
        var count = 0
        var i = 0
        while (i + 1 < n) {
            val s = ((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xff)).toShort().toInt()
            sum += s.toDouble() * s
            count++
            i += 2
        }
        return if (count > 0) sqrt(sum / count) else 0.0
    }

    private fun wavFromPcm(data: ByteArray): ByteArray {
        val byteRate = SAMPLE_RATE * 2
        val out = ByteArrayOutputStream(data.size + 44)
        fun int(v: Int) = byteArrayOf(
            (v and 0xff).toByte(), ((v shr 8) and 0xff).toByte(),
            ((v shr 16) and 0xff).toByte(), ((v shr 24) and 0xff).toByte(),
        )
        fun short(v: Int) = byteArrayOf((v and 0xff).toByte(), ((v shr 8) and 0xff).toByte())
        out.write("RIFF".toByteArray()); out.write(int(data.size + 36)); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); out.write(int(16)); out.write(short(1)); out.write(short(1))
        out.write(int(SAMPLE_RATE)); out.write(int(byteRate)); out.write(short(2)); out.write(short(16))
        out.write("data".toByteArray()); out.write(int(data.size)); out.write(data)
        return out.toByteArray()
    }

    private fun transcribe(wav: ByteArray) {
        try {
            val boundary = "----conductor${System.nanoTime()}"
            val conn = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("Authorization", "Bearer $API_KEY")
                setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            }
            DataOutputStream(conn.outputStream).use { out ->
                fun field(name: String, value: String) {
                    out.writeBytes("--$boundary\r\n")
                    out.writeBytes("Content-Disposition: form-data; name=\"$name\"\r\n\r\n")
                    out.writeBytes("$value\r\n")
                }
                field("model", MODEL)
                field("stream", "false")
                out.writeBytes("--$boundary\r\n")
                out.writeBytes("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n")
                out.writeBytes("Content-Type: audio/wav\r\n\r\n")
                out.write(wav)
                out.writeBytes("\r\n--$boundary--\r\n")
            }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                Log.w(TAG, "ASR http $code: ${body.take(200)}")
                onError("转写失败($code)")
                return
            }
            val text = try { JSONObject(body).optString("text", "").trim() } catch (e: Throwable) { "" }
            if (text.isBlank()) onError("") else onFinal(text)
        } catch (e: Throwable) {
            Log.e(TAG, "transcribe failed", e)
            onError("转写异常")
        }
    }

    companion object {
        private const val TAG = "AudioStt"
        private const val ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions"
        private const val MODEL = "glm-asr-2512"
        private const val API_KEY = "4ea78f2a890c4df78761915fe9f3e219.Vs0I1QrISc3yHn0d"
        private const val SAMPLE_RATE = 16_000
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        private const val MAX_SECONDS = 29
        private const val MIN_BYTES = 4_000
        // ---- VAD tuning (energy of 16-bit samples) ----
        private const val SPEECH_RMS = 1_200.0   // onset: above this counts as speech
        private const val SILENCE_RMS = 700.0     // below this counts as silence
        private const val SILENCE_MS = 1_200      // trailing silence that ends an utterance
        private const val NO_SPEECH_MS = 8_000     // give up if nobody speaks
    }
}
