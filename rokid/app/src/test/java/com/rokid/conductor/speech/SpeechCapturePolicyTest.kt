package com.rokid.conductor.speech

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechCapturePolicyTest {
    @Test
    fun speechAutoStopsAfterFiveSecondsOfSilence() {
        assertFalse(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 8_999L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 1_000L,
                lastSpeechAt = 4_000L,
                manualStopRequired = false,
                stopRequested = false,
            )
        )
        assertTrue(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 9_000L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 1_000L,
                lastSpeechAt = 4_000L,
                manualStopRequired = false,
                stopRequested = false,
            )
        )
    }

    @Test
    fun longSpeechStillAutoStopsAfterFiveSecondsOfSilence() {
        assertFalse(ConductorSpeechTranscriber.shouldRequireManualStop(now = 11_000L, currentSpeechRunStartedAt = 1_000L))
        assertFalse(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 16_999L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 1_000L,
                lastSpeechAt = 12_000L,
                manualStopRequired = false,
                stopRequested = false,
            )
        )
        assertTrue(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 17_000L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 1_000L,
                lastSpeechAt = 12_000L,
                manualStopRequired = false,
                stopRequested = false,
            )
        )
    }

    @Test
    fun manualStopEndsCaptureAfterMinimumRecordingWindow() {
        assertFalse(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 699L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 100L,
                lastSpeechAt = 600L,
                manualStopRequired = true,
                stopRequested = true,
            )
        )
        assertTrue(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 700L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 100L,
                lastSpeechAt = 600L,
                manualStopRequired = true,
                stopRequested = true,
            )
        )
    }

    @Test
    fun noSpeechStillTimesOutAfterLongSilence() {
        assertFalse(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 14_999L,
                captureStartedAt = 0L,
                speechStarted = false,
                speechStartedAt = 0L,
                lastSpeechAt = 0L,
                manualStopRequired = false,
                stopRequested = false,
            )
        )
        assertTrue(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 15_000L,
                captureStartedAt = 0L,
                speechStarted = false,
                speechStartedAt = 0L,
                lastSpeechAt = 0L,
                manualStopRequired = false,
                stopRequested = false,
            )
        )
    }
}
