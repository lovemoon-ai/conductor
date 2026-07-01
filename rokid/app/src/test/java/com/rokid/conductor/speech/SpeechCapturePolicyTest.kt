package com.rokid.conductor.speech

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechCapturePolicyTest {
    @Test
    fun shortSpeechAutoStopsAfterThreeSecondsOfSilence() {
        assertFalse(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 6_999L,
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
                now = 7_000L,
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
    fun longSpeechRequiresManualStopUnlessSilenceIsLong() {
        assertTrue(ConductorSpeechTranscriber.shouldRequireManualStop(now = 11_000L, currentSpeechRunStartedAt = 1_000L))
        assertFalse(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 15_000L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 1_000L,
                lastSpeechAt = 12_000L,
                manualStopRequired = true,
                stopRequested = false,
            )
        )
        assertTrue(
            ConductorSpeechTranscriber.shouldStopCapture(
                now = 27_000L,
                captureStartedAt = 0L,
                speechStarted = true,
                speechStartedAt = 1_000L,
                lastSpeechAt = 12_000L,
                manualStopRequired = true,
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
