package com.rokid.conductor

import com.rokid.conductor.net.ChatMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RokidDisplayRulesTest {
    @Test
    fun pausesAutoBlankingOnlyForOngoingActivity() {
        assertTrue(shouldPauseAutoBlanking(UiState(sttListening = true)))
        assertTrue(shouldPauseAutoBlanking(UiState(ttsSpeaking = true)))
        assertTrue(shouldPauseAutoBlanking(UiState(awaitingReply = true)))
        assertTrue(shouldPauseAutoBlanking(UiState(voiceStatus = "正在准备朗读")))
        assertFalse(shouldPauseAutoBlanking(UiState(messages = listOf(message("1")))))
    }

    @Test
    fun activitySnapshotChangesWhenVisibleEventsArrive() {
        val before = displayActivitySnapshot(UiState(messages = emptyList()))
        val after = displayActivitySnapshot(UiState(messages = listOf(message("1"))))

        assertNotEquals(before, after)
    }

    @Test
    fun manualBlankGestureRequiresOppositeDirectionsWithinOneSecond() {
        val tracker = ManualDisplayBlankGestureTracker()

        assertFalse(tracker.record(HorizontalSwipeDirection.FORWARD, 1_000L))
        assertFalse(tracker.record(HorizontalSwipeDirection.FORWARD, 1_500L))
        assertTrue(tracker.record(HorizontalSwipeDirection.BACKWARD, 2_000L))
    }

    @Test
    fun manualBlankGestureIgnoresSlowOppositeDirections() {
        val tracker = ManualDisplayBlankGestureTracker()

        assertFalse(tracker.record(HorizontalSwipeDirection.FORWARD, 1_000L))
        assertFalse(tracker.record(HorizontalSwipeDirection.BACKWARD, 2_001L))
    }

    @Test
    fun manualBlankGestureCanResetBetweenDirections() {
        val tracker = ManualDisplayBlankGestureTracker()

        assertFalse(tracker.record(HorizontalSwipeDirection.FORWARD, 1_000L))
        tracker.reset()

        assertFalse(tracker.record(HorizontalSwipeDirection.BACKWARD, 1_500L))
    }

    @Test
    fun speechPartialDoesNotMoveRecognizingStatusBackToListening() {
        assertEquals("正在听", voiceStatusForSpeechPartial(null))
        assertEquals("正在听", voiceStatusForSpeechPartial("开始说话"))
        assertEquals("正在识别", voiceStatusForSpeechPartial("正在识别"))
    }

    private fun message(id: String): ChatMessage =
        ChatMessage(id = id, role = "assistant", content = "message", createdAt = "2026-07-02T00:00:00Z")
}
