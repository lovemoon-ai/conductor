package com.rokid.conductor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceCommandMatcherTest {
    @Test
    fun matchesTaskCommandPhrases() {
        assertEquals(VoiceCommand.CONTINUE_TASK, VoiceCommandMatcher.match("继续一下"))
        assertEquals(VoiceCommand.SUMMARIZE_PROGRESS, VoiceCommandMatcher.match("总结进展"))
        assertEquals(VoiceCommand.NEXT_STEP, VoiceCommandMatcher.match("下一步做什么"))
    }

    @Test
    fun matchesLocalReadoutCommands() {
        assertEquals(VoiceCommand.SPEAK_LATEST, VoiceCommandMatcher.match("读一下最新回复"))
        assertEquals(VoiceCommand.STOP_SPEAKING, VoiceCommandMatcher.match("别读了"))
    }

    @Test
    fun ignoresSpacingAndPunctuation() {
        assertEquals(VoiceCommand.SPEAK_LATEST, VoiceCommandMatcher.match("朗读 最新！"))
        assertEquals(VoiceCommand.STOP_SPEAKING, VoiceCommandMatcher.match("停止，朗读。"))
    }

    @Test
    fun doesNotOvermatchDictation() {
        assertNull(VoiceCommandMatcher.match("帮我修改这个任务的实现"))
        assertNull(VoiceCommandMatcher.match(""))
    }
}
