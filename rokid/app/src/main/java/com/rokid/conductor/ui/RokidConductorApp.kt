package com.rokid.conductor.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.rokid.conductor.AppViewModel
import com.rokid.conductor.ChatScrollKind
import com.rokid.conductor.Screen
import com.rokid.conductor.UiState
import com.rokid.conductor.net.ChatMessage
import com.rokid.conductor.net.Project
import com.rokid.conductor.net.TaskItem
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

private val HudGreen = Color(0xFF8CFF8C)
private val HudDim = Color(0xFF8A9A8A)
private val HudWhite = Color.White
private val HudPanel = Color(0xFF071007)
private const val ReadoutFollowIntervalMs = 1_200L
private const val ReadoutFollowMinDeltaPx = 12f
private const val ReadoutFollowMaxStepViewportRatio = 0.45f

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
                    Screen.CHAT -> ChatScreen(state, vm)
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
private fun ChatScreen(state: UiState, vm: AppViewModel) {
    val listState = rememberLazyListState()
    val scrollStepPx = with(LocalDensity.current) { 120.dp.toPx() }
    val selectedTaskId = state.selectedTask?.id
    val voiceStatusText = chatVoiceStatusText(state)
    val voiceStatusIndex = state.messages.size + if (state.awaitingReply) 1 else 0
    val handledScrollRequestId = remember(selectedTaskId) { mutableLongStateOf(0L) }

    LaunchedEffect(selectedTaskId, listState) {
        snapshotFlow {
            listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset
        }.collect { (index, offset) ->
            vm.rememberChatScrollPosition(index, offset)
        }
    }

    LaunchedEffect(state.chatScrollRequest.id, selectedTaskId) {
        val request = state.chatScrollRequest
        if (
            request.id == 0L ||
            request.id == handledScrollRequestId.longValue ||
            state.messages.isEmpty()
        ) {
            return@LaunchedEffect
        }
        handledScrollRequestId.longValue = request.id
        when (request.kind) {
            ChatScrollKind.POSITION -> {
                val index = request.position.index.coerceIn(0, state.messages.lastIndex)
                val offset = request.position.offset.coerceAtLeast(0)
                if (request.animated) {
                    listState.animateScrollToItem(index, offset)
                } else {
                    listState.scrollToItem(index, offset)
                }
            }
            ChatScrollKind.DELTA -> {
                listState.animateScrollBy(request.delta * scrollStepPx)
            }
            ChatScrollKind.DRAG -> {
                listState.scrollBy(request.pixelDelta)
            }
            ChatScrollKind.CENTER -> {
                val index = request.messageId
                    ?.let { id -> state.messages.indexOfFirst { it.id == id } }
                    ?.takeIf { it >= 0 }
                    ?: request.position.index
                listState.animateScrollToItem(index.coerceIn(0, state.messages.lastIndex))
                centerVisibleItem(
                    listState,
                    index.coerceIn(0, state.messages.lastIndex),
                    request.itemAnchorFraction,
                )
            }
        }
    }

    LaunchedEffect(
        voiceStatusText,
        state.sttCandidate,
        state.sttPartial,
        state.sttListening,
        state.messages.size,
        state.awaitingReply,
    ) {
        if (
            voiceStatusText.isNotBlank() &&
            (state.sttCandidate.isNotBlank() || state.sttPartial.isNotBlank() || state.sttListening)
        ) {
            listState.animateScrollToItem(voiceStatusIndex)
        }
    }

    LaunchedEffect(
        state.ttsReadoutRevision,
        state.ttsReadoutMessageId,
        state.ttsReadoutStartedAtMs,
        state.ttsReadoutEstimatedDurationMs,
        state.ttsSpeaking,
        state.messages.size,
    ) {
        val messageId = state.ttsReadoutMessageId ?: return@LaunchedEffect
        val startedAt = state.ttsReadoutStartedAtMs
        val duration = state.ttsReadoutEstimatedDurationMs
        if (!state.ttsSpeaking || startedAt <= 0L || duration <= 0L || state.messages.isEmpty()) {
            return@LaunchedEffect
        }
        val index = state.messages.indexOfFirst { it.id == messageId }.takeIf { it >= 0 }
            ?: return@LaunchedEffect
        while (true) {
            val elapsed = (System.currentTimeMillis() - startedAt).coerceAtLeast(0L)
            val fraction = (elapsed.toFloat() / duration.toFloat()).coerceIn(0f, 1f)
            followReadoutProgress(listState, index, fraction)
            delay(ReadoutFollowIntervalMs)
        }
    }

    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            itemsIndexed(
                items = state.messages,
                key = { index, message ->
                    message.id.takeIf { it.isNotBlank() } ?: "${message.role}-${message.createdAt}-$index"
                },
            ) { _, message ->
                MessageRow(message)
            }
            if (state.awaitingReply) {
                item {
                    Text("AI 正在回复", color = HudDim, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (voiceStatusText.isNotBlank()) {
                item(key = "voice-status") {
                    ChatVoiceStatusBar(text = voiceStatusText, isError = state.error != null)
                }
            }
        }
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
        )
    }
}

@Composable
private fun ChatVoiceStatusBar(text: String, isError: Boolean) {
    Text(
        text,
        color = if (isError) Color(0xFFFF9A9A) else HudDim,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, if (isError) Color(0xFFFF9A9A) else HudDim, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp)
    )
}

private suspend fun centerVisibleItem(
    listState: LazyListState,
    index: Int,
    itemAnchorFraction: Float,
) {
    withFrameNanos { }
    val layoutInfo = listState.layoutInfo
    val itemInfo = layoutInfo.visibleItemsInfo.firstOrNull { it.index == index } ?: return
    val viewportCenter = (layoutInfo.viewportStartOffset + layoutInfo.viewportEndOffset) / 2
    val itemAnchor = itemInfo.offset + (itemInfo.size * itemAnchorFraction.coerceIn(0f, 1f)).roundToInt()
    listState.animateScrollBy((itemAnchor - viewportCenter).toFloat())
}

private suspend fun followReadoutProgress(
    listState: LazyListState,
    index: Int,
    progressFraction: Float,
) {
    withFrameNanos { }
    var layoutInfo = listState.layoutInfo
    var itemInfo = layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }
    if (itemInfo == null) {
        listState.scrollToItem(index)
        withFrameNanos { }
        layoutInfo = listState.layoutInfo
        itemInfo = layoutInfo.visibleItemsInfo.firstOrNull { it.index == index } ?: return
    }

    val viewportHeight = (layoutInfo.viewportEndOffset - layoutInfo.viewportStartOffset).coerceAtLeast(1)
    val viewportCenter = (layoutInfo.viewportStartOffset + layoutInfo.viewportEndOffset) / 2
    val itemAnchor = itemInfo.offset + (itemInfo.size * progressFraction.coerceIn(0f, 1f)).roundToInt()
    val delta = (itemAnchor - viewportCenter).toFloat()
    if (abs(delta) < ReadoutFollowMinDeltaPx) return

    val maxStep = viewportHeight * ReadoutFollowMaxStepViewportRatio
    listState.animateScrollBy(delta.coerceIn(-maxStep, maxStep))
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
