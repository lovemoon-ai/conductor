package com.rokid.conductor.speech

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechOutputTextTest {
    @Test
    fun cleansMarkdownBeforeSpeech() {
        val cleaned = cleanTextForSpeech(
            """
            # 标题
            这里有 `inline code` 和 [链接](https://example.com)。
            ```kotlin
            println("secret")
            ```
            """.trimIndent()
        )

        assertEquals("标题 这里有 inline code 和 链接。 代码省略", cleaned)
    }

    @Test
    fun splitsLongSpeechWithoutDroppingTail() {
        val text = "第一段内容很多，需要尽快开始朗读。第二段内容也很多，需要继续排队播放。第三段结尾不能被截断。"

        val chunks = splitTextForSpeech(text, maxChunkChars = 18)

        assertTrue(chunks.size > 1)
        assertTrue(chunks.all { it.length <= 18 })
        assertEquals(cleanTextForSpeech(text), chunks.joinToString(""))
        assertTrue(chunks.last().endsWith("截断。"))
    }

    @Test
    fun blankSpeechProducesNoChunks() {
        assertFalse(splitTextForSpeech("   \n\t").isNotEmpty())
    }

    @Test
    fun prefersRokidSpeechEngineWhenServiceIsConnected() {
        assertEquals(
            listOf(SpeechEngine.ROKID, SpeechEngine.ANDROID),
            speechEnginePriority(hasRokidServer = true),
        )
    }

    @Test
    fun fallsBackToAndroidWhenRokidEngineIsSkipped() {
        assertEquals(
            listOf(SpeechEngine.ANDROID),
            speechEnginePriority(hasRokidServer = true, skipEngine = SpeechEngine.ROKID),
        )
    }
}
