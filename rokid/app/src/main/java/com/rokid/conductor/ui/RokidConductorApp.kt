package com.rokid.conductor.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
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
            Header(state)
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
            Footer(state)
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
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            content()
        }
    }
}

@Composable
private fun Header(state: UiState) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(44.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "Conductor",
                color = HudWhite,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 1
            )
            Text(
                screenLabel(state),
                color = HudDim,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (state.screen != Screen.LOGIN) {
            StatusDot(if (state.realtimeConnected) HudGreen else HudDim)
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
        emptyText = "没有项目",
        countText = countText(state.focusedProjectIndex, state.projects.size),
        items = state.projects,
        focusedIndex = state.focusedProjectIndex,
        title = { it.name },
        subtitle = { projectSubtitle(it) },
    )
}

@Composable
private fun TasksScreen(state: UiState) {
    FocusedList(
        emptyText = "没有任务",
        countText = countText(state.focusedTaskIndex, state.tasks.size),
        items = state.tasks,
        focusedIndex = state.focusedTaskIndex,
        title = { it.title },
        subtitle = { "状态 ${it.status}" },
    )
}

@Composable
private fun <T> FocusedList(
    emptyText: String,
    countText: String,
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

    val start = (focusedIndex - 2).coerceAtLeast(0)
    val end = (start + 5).coerceAtMost(items.size)
    val adjustedStart = (end - 5).coerceAtLeast(0)
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(countText, color = HudDim, style = MaterialTheme.typography.labelMedium)
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
            .height(62.dp)
    ) {
        Column(
            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
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
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            state.selectedTask?.title ?: "对话",
            color = HudGreen,
            style = MaterialTheme.typography.titleSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
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
        QuickReplyPanel(state)
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
private fun QuickReplyPanel(state: UiState) {
    val activeVoice = state.sttListening || state.ttsSpeaking
    val border = if (activeVoice) HudGreen else HudDim
    val selected = state.quickReplies.getOrNull(state.focusedQuickReplyIndex) ?: ""
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, border, RoundedCornerShape(4.dp))
            .padding(10.dp)
    ) {
        Text(
            voiceActionTitle(state, selected),
            color = if (activeVoice) HudGreen else HudWhite,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold
        )
        Text(
            state.sttPartial.ifBlank {
                when {
                    state.sttListening -> state.voiceStatus ?: "再次轻触结束语音"
                    state.ttsSpeaking -> state.voiceStatus ?: "正在朗读"
                    else -> "${state.focusedQuickReplyIndex + 1}/${state.quickReplies.size}  $selected"
                }
            },
            color = HudDim,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun Footer(state: UiState) {
    val message = state.error ?: state.info ?: state.voiceStatus ?: footerHint(state)
    Text(
        message,
        color = if (state.error != null) Color(0xFFFF9A9A) else HudDim,
        style = MaterialTheme.typography.labelSmall,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .height(36.dp)
    )
}

@Composable
private fun StatusDot(color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(8.dp)
                .background(color, CircleShape)
        )
        Spacer(Modifier.width(6.dp))
        Text("WS", color = HudDim, style = MaterialTheme.typography.labelSmall)
    }
}

private fun visibleMessages(state: UiState): List<ChatMessage> {
    if (state.messages.isEmpty()) return emptyList()
    val end = (state.messages.size - state.messageScrollOffset).coerceIn(0, state.messages.size)
    val start = (end - 4).coerceAtLeast(0)
    return state.messages.subList(start, end)
}

private fun screenLabel(state: UiState): String = when (state.screen) {
    Screen.LOGIN -> "设备登录"
    Screen.PROJECTS -> state.userLabel ?: "项目"
    Screen.TASKS -> state.selectedProject?.name ?: "任务"
    Screen.CHAT -> if (state.realtimeConnected) "实时已连接" else "实时连接中"
}

private fun footerHint(state: UiState): String = when (state.screen) {
    Screen.LOGIN -> "轻触重新生成，双击退出"
    Screen.PROJECTS -> "滑动选择项目，轻触进入"
    Screen.TASKS -> "滑动选择任务，轻触进入"
    Screen.CHAT -> voiceHint(state)
}

private fun voiceActionTitle(state: UiState, selected: String): String = when {
    state.sttListening -> "正在听"
    state.ttsSpeaking -> "正在朗读"
    selected == "语音输入" -> if (state.sttAvailable) "轻触说话" else "语音输入不可用"
    selected == "朗读最新" -> if (state.ttsAvailable) "轻触朗读" else "朗读不可用"
    selected == "停止朗读" -> "轻触停止"
    else -> "轻触发送"
}

private fun voiceHint(state: UiState): String {
    if (state.sttListening) return "再次轻触结束语音"
    if (state.ttsSpeaking) return "双击停止朗读"
    val voice = when {
        !state.sttAvailable && !state.ttsAvailable -> "语音服务不可用"
        !state.sttAvailable -> "语音输入不可用"
        !state.ttsAvailable && state.ttsReady -> "朗读不可用"
        else -> null
    }
    return voice ?: "滑动选择回复，轻触发送"
}

private fun countText(index: Int, size: Int): String =
    if (size <= 0) "0 / 0" else "${index + 1} / $size"

private fun projectSubtitle(project: Project): String =
    if (project.isDefault) "默认项目" else project.id

private fun roleLabel(role: String) = when (role) {
    "user" -> "我"
    "assistant", "sdk" -> "AI"
    "system" -> "系统"
    else -> role
}
