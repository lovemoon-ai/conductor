package com.rokid.conductor

internal enum class HorizontalSwipeDirection {
    FORWARD,
    BACKWARD,
}

internal fun shouldPauseAutoBlanking(state: UiState): Boolean =
    state.loading ||
        state.awaitingReply ||
        state.sttListening ||
        state.ttsSpeaking ||
        state.voiceStatus in ActiveVoiceStatuses

private val ActiveVoiceStatuses = setOf(
    "正在启动语音识别",
    "开始说话",
    "正在听",
    "正在识别",
    "语音朗读初始化中",
    "正在准备朗读",
    "正在朗读",
)

internal data class DisplayActivitySnapshot(
    val loading: Boolean,
    val awaitingReply: Boolean,
    val sttListening: Boolean,
    val sttPartial: String,
    val ttsSpeaking: Boolean,
    val voiceStatus: String?,
    val messageCount: Int,
)

internal fun displayActivitySnapshot(state: UiState): DisplayActivitySnapshot =
    DisplayActivitySnapshot(
        loading = state.loading,
        awaitingReply = state.awaitingReply,
        sttListening = state.sttListening,
        sttPartial = state.sttPartial,
        ttsSpeaking = state.ttsSpeaking,
        voiceStatus = state.voiceStatus,
        messageCount = state.messages.size,
    )

internal class ManualDisplayBlankGestureTracker(
    private val windowMs: Long = DefaultWindowMs,
) {
    private var lastDirection: HorizontalSwipeDirection? = null
    private var lastAtMs: Long = 0L

    fun record(direction: HorizontalSwipeDirection, atMs: Long): Boolean {
        val matched = lastDirection != null &&
            lastDirection != direction &&
            atMs - lastAtMs in 0..windowMs
        lastDirection = direction
        lastAtMs = atMs
        if (matched) {
            reset()
        }
        return matched
    }

    fun reset() {
        lastDirection = null
        lastAtMs = 0L
    }

    companion object {
        const val DefaultWindowMs = 1_000L
    }
}
