package com.rokid.conductor.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.rokid.conductor.AppViewModel
import com.rokid.conductor.Screen
import com.rokid.conductor.UiState
import com.rokid.conductor.VisibleChatMessageCount
import com.rokid.conductor.net.ChatMessage
import com.rokid.conductor.net.Project
import com.rokid.conductor.net.TaskItem

private val HudGreen = Color(0xFF8CFF8C)
private val HudDim = Color(0xFF8A9A8A)
private val HudWhite = Color.White
private val HudPanel = Color(0xFF071007)

@Composable
fun RokidConductorApp(vm: AppViewModel) {
    val state by vm.state.collectAsState()
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black),
        contentAlignment = Alignment.Center
    ) {
        HudViewport {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            ) {
                when (state.screen) {
                    Screen.LOGIN -> LoginScreen(state)
                    Screen.PROJECTS -> ProjectsScreen(state)
                    Screen.TASKS -> TasksScreen(state)
                    Screen.CHAT -> ChatScreen(state)
                }
                if (state.loading) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(Color(0xAA000000)),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator(color = HudGreen)
                    }
                }
            }
        }
    }
}

@Composable
private fun HudViewport(content: @Composable ColumnScope.() -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth.value / maxHeight.value > 0.75f
        val viewportModifier = if (wide) {
            Modifier
                .fillMaxHeight()
                .aspectRatio(0.75f)
        } else {
            Modifier
                .fillMaxWidth()
                .aspectRatio(0.75f)
        }
        Column(
            modifier = viewportModifier
                .align(Alignment.Center)
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            content()
        }
    }
}

@Composable
private fun LoginScreen(state: UiState) {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            state.deviceUserCode ?: "---- ----",
            color = HudGreen,
            style = MaterialTheme.typography.displaySmall,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            maxLines = 1
        )
        Spacer(Modifier.height(12.dp))
        Text(
            state.verificationUri ?: state.baseUrl.trimEnd('/') + "/activate",
            color = HudWhite,
            style = MaterialTheme.typography.titleSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.height(8.dp))
        Text(
            state.verificationUriComplete ?: "",
            color = HudDim,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(Modifier.height(18.dp))
        Text(
            state.deviceLoginStatus,
            color = HudDim,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun ProjectsScreen(state: UiState) {
    FocusedList(
        emptyText = state.error ?: "没有项目",
        items = state.projects,
        focusedIndex = state.focusedProjectIndex,
        title = { it.name },
        subtitle = { projectSubtitle(it) },
    )
}

@Composable
private fun TasksScreen(state: UiState) {
    FocusedList(
        emptyText = state.error ?: "没有任务",
        items = state.tasks,
        focusedIndex = state.focusedTaskIndex,
        title = { it.title },
        subtitle = { taskSubtitle(it) },
    )
}

@Composable
private fun <T> FocusedList(
    emptyText: String,
    items: List<T>,
    focusedIndex: Int,
    title: (T) -> String,
    subtitle: (T) -> String,
) {
    if (items.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(emptyText, color = HudDim, style = MaterialTheme.typography.titleMedium)
        }
        return
    }

    val visibleRows = 7
    val start = (focusedIndex - visibleRows / 2).coerceAtLeast(0)
    val end = (start + visibleRows).coerceAtMost(items.size)
    val adjustedStart = (end - visibleRows).coerceAtLeast(0)
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items.subList(adjustedStart, end).forEachIndexed { offset, item ->
            val index = adjustedStart + offset
            FocusRow(
                focused = index == focusedIndex,
                title = title(item),
                subtitle = subtitle(item),
            )
        }
    }
}

@Composable
private fun FocusRow(focused: Boolean, title: String, subtitle: String) {
    Surface(
        color = if (focused) HudPanel else Color.Black,
        border = BorderStroke(if (focused) 1.dp else 0.dp, if (focused) HudGreen else Color.Transparent),
        shape = RoundedCornerShape(4.dp),
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp)
    ) {
        Column(
            Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                title,
                color = if (focused) HudGreen else HudWhite,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = if (focused) FontWeight.Bold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                subtitle,
                color = HudDim,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun ChatScreen(state: UiState) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            visibleMessages(state).forEach { message ->
                MessageRow(message)
            }
            if (state.awaitingReply) {
                Text("AI 正在回复", color = HudDim, style = MaterialTheme.typography.bodySmall)
            }
        }
        ChatVoiceStatusBar(state)
    }
}

@Composable
private fun MessageRow(message: ChatMessage) {
    val isUser = message.role == "user"
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, if (isUser) HudDim else HudGreen, RoundedCornerShape(4.dp))
            .padding(8.dp)
    ) {
        Text(
            roleLabel(message.role),
            color = if (isUser) HudDim else HudGreen,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            maxLines = 1
        )
        Text(
            message.content.ifBlank { "(空)" },
            color = HudWhite,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 5,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun ChatVoiceStatusBar(state: UiState) {
    val text = chatVoiceStatusText(state)
    if (text.isBlank()) return
    val isError = state.error != null
    Text(
        text,
        color = if (isError) Color(0xFFFF9A9A) else HudDim,
        style = MaterialTheme.typography.bodySmall,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, if (isError) Color(0xFFFF9A9A) else HudDim, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp)
    )
}

private fun visibleMessages(state: UiState): List<ChatMessage> {
    if (state.messages.isEmpty()) return emptyList()
    val start = state.chatTopMessageIndex.coerceIn(0, state.messages.lastIndex)
    val end = (start + VisibleChatMessageCount).coerceAtMost(state.messages.size)
    return state.messages.subList(start, end)
}

private fun projectSubtitle(project: Project): String =
    buildList {
        if (project.isDefault) add("默认")
        if (project.memberIds.size > 1) add("合并")
        val daemon = project.daemonHosts.joinToString(" / ").ifBlank {
            project.daemonHost ?: "未绑定 daemon"
        }
        add("daemon $daemon")
    }.joinToString(" · ")

private fun taskSubtitle(task: TaskItem): String =
    buildList {
        if (task.pinnedAt != null) add("置顶")
        add("状态 ${task.status}")
    }.joinToString(" · ")

private fun chatVoiceStatusText(state: UiState): String = when {
    state.error != null -> state.error
    state.sttCandidate.isNotBlank() -> "识别结果: ${state.sttCandidate}"
    state.sttPartial.isNotBlank() -> "识别中: ${state.sttPartial}"
    state.sttListening -> state.voiceStatus ?: "正在听"
    state.ttsSpeaking -> state.voiceStatus ?: "正在朗读"
    state.info != null -> state.info
    state.voiceStatus != null -> state.voiceStatus
    !state.sttAvailable -> "语音输入不可用"
    state.ttsReady && !state.ttsAvailable -> "朗读不可用"
    else -> ""
}

private fun roleLabel(role: String) = when (role) {
    "user" -> "我"
    "assistant", "sdk" -> "AI"
    "system" -> "系统"
    else -> role
}
