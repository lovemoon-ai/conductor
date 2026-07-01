package com.rokid.conductor

import com.rokid.conductor.net.ChatMessage
import com.rokid.conductor.net.Project
import com.rokid.conductor.net.TaskItem
import com.rokid.conductor.net.canMergeProjectsForRokid
import com.rokid.conductor.net.groupProjectsForRokid
import com.rokid.conductor.net.orderTasksForRokid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RokidPresentationRulesTest {
    @Test
    fun mergesSameNamedProjectsAcrossDifferentDaemons() {
        val a = Project(
            id = "p-a",
            name = "Conductor",
            isDefault = false,
            daemonHost = "daemon-a",
            gitRemoteUrl = "git@example.com:conductor.git",
        )
        val b = Project(
            id = "p-b",
            name = "Conductor",
            isDefault = false,
            daemonHost = "daemon-b",
            gitRemoteUrl = "GIT@example.com:conductor.git",
        )

        val groups = groupProjectsForRokid(listOf(a, b))

        assertTrue(canMergeProjectsForRokid(a, b))
        assertEquals(1, groups.size)
        assertEquals(listOf("p-a", "p-b"), groups.single().memberIds)
        assertEquals(listOf("daemon-a", "daemon-b"), groups.single().daemonHosts)
    }

    @Test
    fun keepsOptedOutOrSameDaemonProjectsSeparate() {
        val base = Project(id = "p-a", name = "App", isDefault = false, daemonHost = "daemon-a")
        val sameDaemon = Project(id = "p-b", name = "App", isDefault = false, daemonHost = "daemon-a")
        val optedOut = Project(
            id = "p-c",
            name = "App",
            isDefault = false,
            daemonHost = "daemon-c",
            mergeOptOut = true,
        )

        assertFalse(canMergeProjectsForRokid(base, sameDaemon))
        assertFalse(canMergeProjectsForRokid(base, optedOut))
        assertEquals(3, groupProjectsForRokid(listOf(base, sameDaemon, optedOut)).size)
    }

    @Test
    fun ordersPinnedTasksFirstAndDropsHiddenTasks() {
        val tasks = listOf(
            TaskItem(id = "normal", projectId = "p", title = "Normal", status = "running", taskType = "ai_task"),
            TaskItem(
                id = "old-pin",
                projectId = "p",
                title = "Old Pin",
                status = "running",
                taskType = "ai_task",
                pinnedAt = "2026-01-01T00:00:00Z",
            ),
            TaskItem(id = "hidden", projectId = "p", title = "Hidden", status = "hide", taskType = "ai_task", hidden = true),
            TaskItem(
                id = "new-pin",
                projectId = "p",
                title = "New Pin",
                status = "running",
                taskType = "ai_task",
                pinnedAt = "2026-02-01T00:00:00Z",
            ),
        )

        assertEquals(listOf("new-pin", "old-pin", "normal"), orderTasksForRokid(tasks).map { it.id })
    }

    @Test
    fun chatDefaultsToLatestUserMessageAtTop() {
        val messages = listOf(
            message("1", "user"),
            message("2", "assistant"),
            message("3", "user"),
            message("4", "assistant"),
        )

        assertEquals(2, defaultChatTopMessageIndex(messages))
    }

    @Test
    fun readoutCentersSpokenMessageWhenPossible() {
        val messages = (1..6).map { index ->
            message(index.toString(), if (index % 2 == 0) "assistant" else "user")
        }

        assertEquals(2, centeredChatTopMessageIndex(messages, "5"))
    }

    private fun message(id: String, role: String): ChatMessage =
        ChatMessage(id = id, role = role, content = "message $id", createdAt = "2026-01-01T00:00:00Z")
}
