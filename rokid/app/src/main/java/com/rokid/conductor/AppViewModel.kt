package com.rokid.conductor

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.conductor.net.ChatMessage
import com.rokid.conductor.net.ConductorClient
import com.rokid.conductor.net.ConductorSocket
import com.rokid.conductor.net.Project
import com.rokid.conductor.net.RealtimeEvent
import com.rokid.conductor.net.TaskItem
import com.rokid.conductor.speech.SpeechInput
import com.rokid.conductor.speech.SpeechOutput
import java.util.ArrayDeque
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class Screen { LOGIN, PROJECTS, TASKS, CHAT }

enum class HudAction { SELECT, BACK, NEXT, PREVIOUS }

enum class VoiceCommand { CONTINUE_TASK, SUMMARIZE_PROGRESS, NEXT_STEP, SPEAK_LATEST, STOP_SPEAKING }

enum class ChatScrollKind { POSITION, DELTA, DRAG, CENTER }

internal object VoiceCommandMatcher {
    fun match(text: String): VoiceCommand? {
        val normalized = normalize(text)
        if (normalized.isBlank()) return null
        return when {
            normalized in setOf("继续", "继续一下", "继续任务", "继续这个任务", "接着", "接着说") ->
                VoiceCommand.CONTINUE_TASK
            normalized in setOf("总结", "总结一下", "总结进展", "汇总进展", "汇报进展") ->
                VoiceCommand.SUMMARIZE_PROGRESS
            normalized in setOf("下一步", "下步", "下一步做什么", "继续下一步") ->
                VoiceCommand.NEXT_STEP
            normalized in setOf("朗读最新", "读最新", "读一下最新", "读一下最新回复", "念最新", "念一下最新") ->
                VoiceCommand.SPEAK_LATEST
            normalized in setOf("停止朗读", "停止播放", "别读了", "不用读了", "停", "停止") ->
                VoiceCommand.STOP_SPEAKING
            else -> null
        }
    }

    private fun normalize(text: String): String =
        text.lowercase()
            .replace(Regex("[\\s\\p{Punct}，。！？、；：“”‘’（）【】《》]+"), "")
}

private const val ProductionBaseUrl = "https://conductor.conductor-ai.top"
internal const val VisibleChatMessageCount = 4

data class ChatScrollPosition(
    val index: Int,
    val offset: Int = 0,
)

data class ChatScrollRequest(
    val id: Long = 0,
    val kind: ChatScrollKind = ChatScrollKind.POSITION,
    val position: ChatScrollPosition = ChatScrollPosition(0),
    val delta: Int = 0,
    val pixelDelta: Float = 0f,
    val messageId: String? = null,
    val itemAnchorFraction: Float = 0.5f,
    val animated: Boolean = false,
)

private data class PendingSpeech(
    val text: String,
    val messageId: String?,
)

private fun normalizeBaseUrl(value: String?): String {
    val normalized = value
        ?.trim()
        ?.removeSuffix("/")
        ?.removeSuffix("/activate")
        ?.removeSuffix("/")
        .orEmpty()
    return when {
        normalized.isBlank() -> ProductionBaseUrl
        normalized == "https://conductor-ai.top" -> ProductionBaseUrl
        normalized.startsWith("http://") -> ProductionBaseUrl
        else -> normalized
    }
}

data class UiState(
    val screen: Screen = Screen.LOGIN,
    val baseUrl: String = ProductionBaseUrl,
    val loading: Boolean = false,
    val error: String? = null,
    val info: String? = null,
    val userLabel: String? = null,
    val deviceUserCode: String? = null,
    val verificationUri: String? = null,
    val verificationUriComplete: String? = null,
    val deviceLoginStatus: String = "正在准备登录",
    val projects: List<Project> = emptyList(),
    val focusedProjectIndex: Int = 0,
    val selectedProject: Project? = null,
    val tasks: List<TaskItem> = emptyList(),
    val focusedTaskIndex: Int = 0,
    val selectedTask: TaskItem? = null,
    val messages: List<ChatMessage> = emptyList(),
    val chatScrollRequest: ChatScrollRequest = ChatScrollRequest(),
    val awaitingReply: Boolean = false,
    val realtimeConnected: Boolean = false,
    val sttListening: Boolean = false,
    val sttPartial: String = "",
    val sttCandidate: String = "",
    val sttCandidateCommand: VoiceCommand? = null,
    val sttAvailable: Boolean = true,
    val ttsReady: Boolean = false,
    val ttsAvailable: Boolean = false,
    val ttsSpeaking: Boolean = false,
    val ttsReadoutMessageId: String? = null,
    val ttsReadoutStartedAtMs: Long = 0L,
    val ttsReadoutEstimatedDurationMs: Long = 0L,
    val ttsReadoutRevision: Long = 0L,
    val displayBlanked: Boolean = false,
    val voiceStatus: String? = null,
)

internal fun clampChatMessageIndex(index: Int, messageCount: Int): Int {
    if (messageCount <= 0) return 0
    return min(max(0, index), messageCount - 1)
}

internal fun defaultChatScrollPosition(messages: List<ChatMessage>): ChatScrollPosition {
    if (messages.isEmpty()) return ChatScrollPosition(0)
    val latestUserIndex = messages.indexOfLast { it.role == "user" }
    val target = if (latestUserIndex >= 0) {
        latestUserIndex
    } else {
        (messages.size - VisibleChatMessageCount).coerceAtLeast(0)
    }
    return ChatScrollPosition(clampChatMessageIndex(target, messages.size))
}

internal fun centeredChatScrollPosition(messages: List<ChatMessage>, messageId: String): ChatScrollPosition {
    if (messages.isEmpty()) return ChatScrollPosition(0)
    val targetIndex = messages.indexOfFirst { it.id == messageId }.takeIf { it >= 0 }
        ?: return ChatScrollPosition(0)
    return ChatScrollPosition(clampChatMessageIndex(targetIndex - VisibleChatMessageCount / 2, messages.size))
}

internal fun estimateTtsReadoutDurationMs(text: String): Long {
    val trimmed = text.replace(Regex("\\s+"), "")
    if (trimmed.isBlank()) return 0L
    val cjkCount = trimmed.count { it.isCjkSpeechChar() }
    val otherCount = (trimmed.length - cjkCount).coerceAtLeast(0)
    val estimated = cjkCount * 260L + otherCount * 90L
    return estimated.coerceIn(4_000L, 180_000L)
}

private fun Char.isCjkSpeechChar(): Boolean =
    code in 0x4E00..0x9FFF ||
        code in 0x3400..0x4DBF ||
        code in 0x3040..0x30FF ||
        code in 0xAC00..0xD7AF

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = app.getSharedPreferences("rokid_conductor", Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val _state = MutableStateFlow(
        UiState(baseUrl = normalizeBaseUrl(prefs.getString("baseUrl", null)))
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val client = ConductorClient(_state.value.baseUrl, prefs.getString("token", null))
    private val pendingSpeech = ArrayDeque<PendingSpeech>()
    private var activeSpeech: PendingSpeech? = null
    private val speaker = SpeechOutput(
        context = app.applicationContext,
        onAvailability = { available, status ->
            _state.update {
                it.copy(
                    ttsReady = true,
                    ttsAvailable = available,
                    voiceStatus = if (available) null else status,
                )
            }
            if (available) playNextPendingSpeech()
        },
        onSpeakingChanged = { speaking -> handleSpeechOutputStateChanged(speaking) },
        onChunkStarted = { _, _ -> },
        onError = { msg ->
            activeSpeech = null
            _state.update {
                it.copy(
                    ttsSpeaking = false,
                    ttsReadoutMessageId = null,
                    ttsReadoutStartedAtMs = 0L,
                    ttsReadoutEstimatedDurationMs = 0L,
                    error = msg,
                    voiceStatus = null,
                )
            }
            playNextPendingSpeech()
        },
    )
    private var socket: ConductorSocket? = null
    private var speech: SpeechInput? = null
    private var deviceLoginJob: Job? = null
    private val chatScrollPositionsByTaskId = mutableMapOf<String, ChatScrollPosition>()
    private val manuallyScrolledTaskIds = mutableSetOf<String>()
    private var nextChatScrollRequestId = 0L
    private var autoSubmitCurrentVoiceInput = false

    init {
        _state.update { it.copy(sttAvailable = SpeechInput.isAvailable(app.applicationContext)) }
        if (client.token.isNullOrBlank()) {
            startDeviceLogin()
        } else {
            restoreSession()
        }
    }

    private fun restoreSession() = viewModelScope.launch {
        _state.update { it.copy(loading = true, error = null, deviceLoginStatus = "正在恢复会话") }
        runCatching { client.me() }
            .onSuccess { label ->
                _state.update {
                    it.copy(
                        loading = false,
                        userLabel = label,
                        screen = Screen.PROJECTS,
                        deviceUserCode = null,
                        verificationUri = null,
                        verificationUriComplete = null,
                    )
                }
                openRealtime()
                loadProjects()
            }
            .onFailure {
                client.token = null
                prefs.edit().remove("token").apply()
                _state.update { it.copy(loading = false, screen = Screen.LOGIN) }
                startDeviceLogin()
            }
    }

    fun startDeviceLogin() {
        deviceLoginJob?.cancel()
        socket?.stop()
        socket = null
        stopSpeaking()
        stopVoice()
        client.token = null
        client.baseUrl = _state.value.baseUrl.trimEnd('/')
        viewModelScope.launch {
            _state.update {
                it.copy(
                    screen = Screen.LOGIN,
                    loading = true,
                    error = null,
                    info = null,
                    userLabel = null,
                    deviceLoginStatus = "正在生成登录码",
                )
            }
            runCatching { client.startDeviceAuthorization() }
                .onSuccess { auth ->
                    _state.update {
                        it.copy(
                            loading = false,
                            deviceUserCode = auth.userCode,
                            verificationUri = auth.verificationUri,
                            verificationUriComplete = auth.verificationUriComplete,
                            deviceLoginStatus = "等待网页端确认",
                        )
                    }
                    deviceLoginJob = viewModelScope.launch {
                        pollDeviceLogin(auth.deviceCode, auth.interval)
                    }
                }
                .onFailure { e ->
                    _state.update {
                        it.copy(
                            loading = false,
                            deviceLoginStatus = "登录码生成失败",
                            error = e.message ?: "无法启动设备登录",
                        )
                    }
                }
        }
    }

    private suspend fun pollDeviceLogin(deviceCode: String, intervalSeconds: Int) {
        while (true) {
            delay(intervalSeconds * 1000L)
            val poll = runCatching { client.pollDeviceAuthorization(deviceCode) }
                .onFailure { e ->
                    _state.update {
                        it.copy(error = e.message ?: "登录轮询失败", deviceLoginStatus = "登录失败")
                    }
                }
                .getOrNull() ?: return

            when (poll.status) {
                "pending" -> _state.update { it.copy(deviceLoginStatus = "等待网页端确认") }
                "approved" -> {
                    val token = poll.agentToken
                    if (token.isNullOrBlank()) {
                        _state.update {
                            it.copy(error = "授权成功但没有返回 token", deviceLoginStatus = "登录失败")
                        }
                        return
                    }
                    poll.backendUrl?.let { client.baseUrl = normalizeBaseUrl(it) }
                    client.token = token
                    _state.update { it.copy(baseUrl = client.baseUrl) }
                    prefs.edit()
                        .putString("token", token)
                        .putString("baseUrl", client.baseUrl)
                        .apply()
                    finishDeviceLogin()
                    return
                }
                "expired" -> {
                    _state.update {
                        it.copy(
                            error = poll.message ?: "登录码已过期，轻触重新生成",
                            deviceLoginStatus = "登录码已过期",
                        )
                    }
                    return
                }
                "denied", "consumed" -> {
                    _state.update {
                        it.copy(
                            error = poll.message ?: "设备登录未完成",
                            deviceLoginStatus = "登录未完成",
                        )
                    }
                    return
                }
                else -> _state.update {
                    it.copy(error = poll.message ?: "未知登录状态: ${poll.status}")
                }
            }
        }
    }

    private fun finishDeviceLogin() = viewModelScope.launch {
        _state.update { it.copy(loading = true, deviceLoginStatus = "正在进入 Conductor") }
        runCatching { client.me() }
            .onSuccess { label ->
                _state.update {
                    it.copy(
                        loading = false,
                        screen = Screen.PROJECTS,
                        userLabel = label,
                        deviceUserCode = null,
                        verificationUri = null,
                        verificationUriComplete = null,
                        projects = emptyList(),
                        focusedProjectIndex = 0,
                    )
                }
                openRealtime()
                loadProjects()
            }
            .onFailure { e ->
                client.token = null
                prefs.edit().remove("token").apply()
                _state.update {
                    it.copy(
                        loading = false,
                        screen = Screen.LOGIN,
                        error = e.message ?: "登录 token 无效",
                    )
                }
                startDeviceLogin()
            }
    }

    fun clearMessages() = _state.update { it.copy(error = null, info = null) }

    fun logout() {
        deviceLoginJob?.cancel()
        socket?.stop()
        socket = null
        stopSpeaking()
        stopVoice()
        client.token = null
        prefs.edit().remove("token").apply()
        _state.update { UiState(baseUrl = it.baseUrl) }
        startDeviceLogin()
    }

    // ---- Projects ----

    fun loadProjects() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listProjects() }
                .onSuccess { ps ->
                    _state.update {
                        it.copy(
                            loading = false,
                            projects = ps,
                            focusedProjectIndex = clampIndex(it.focusedProjectIndex, ps.size),
                        )
                    }
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    private fun selectFocusedProject() {
        val s = _state.value
        val project = s.projects.getOrNull(s.focusedProjectIndex)
        if (project == null) {
            loadProjects()
            return
        }
        selectProject(project)
    }

    private fun selectProject(p: Project) {
        _state.update {
            it.copy(
                selectedProject = p,
                screen = Screen.TASKS,
                tasks = emptyList(),
                focusedTaskIndex = 0,
                error = null,
            )
        }
        loadTasks()
    }

    fun loadTasks() {
        val project = _state.value.selectedProject ?: return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listTasks(project.memberIds) }
                .onSuccess { ts ->
                    _state.update {
                        it.copy(
                            loading = false,
                            tasks = ts,
                            focusedTaskIndex = clampIndex(it.focusedTaskIndex, ts.size),
                        )
                    }
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    private fun selectFocusedTask() {
        val s = _state.value
        val task = s.tasks.getOrNull(s.focusedTaskIndex)
        if (task == null) {
            loadTasks()
            return
        }
        selectTask(task)
    }

    private fun selectTask(t: TaskItem) {
        _state.update {
            it.copy(
                selectedTask = t,
                screen = Screen.CHAT,
                messages = emptyList(),
                chatScrollRequest = ChatScrollRequest(),
                awaitingReply = false,
                error = null,
            )
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listMessages(t.id) }
                .onSuccess { ms ->
                    val request = positionChatScrollRequest(chatScrollPositionForTask(t.id, ms))
                    _state.update {
                        it.copy(
                            loading = false,
                            messages = ms,
                            chatScrollRequest = request,
                        )
                    }
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    // ---- Chat ----

    fun sendText(content: String) {
        val task = _state.value.selectedTask ?: return
        val text = content.trim()
        if (text.isEmpty()) return
        manuallyScrolledTaskIds.remove(task.id)
        chatScrollPositionsByTaskId.remove(task.id)
        val request = positionChatScrollRequest(defaultChatScrollPosition(_state.value.messages), animated = true)
        _state.update {
            it.copy(
                awaitingReply = true,
                error = null,
                sttPartial = "",
                sttCandidate = "",
                sttCandidateCommand = null,
                voiceStatus = null,
                chatScrollRequest = request,
            )
        }
        viewModelScope.launch {
            runCatching { client.sendUserMessage(task.id, text, UUID.randomUUID().toString()) }
                .onSuccess { msg -> addMessage(msg) }
                .onFailure { e ->
                    _state.update {
                        it.copy(awaitingReply = false, error = e.message ?: "发送失败")
                    }
                }
        }
    }

    /** Substantive AI output worth showing on the HUD. */
    private fun isAiReply(role: String, content: String): Boolean {
        if (role == "user" || content.isBlank()) return false
        val c = content.lowercase()
        val noise = c.contains("session started") || c.contains("session ready") ||
            c.contains("session resumed")
        return !noise
    }

    private fun addMessage(msg: ChatMessage) {
        val st = _state.value
        if (msg.id.isNotBlank() && st.messages.any { it.id == msg.id }) return
        val messages = st.messages + msg
        val taskId = st.selectedTask?.id
        val request = if (taskId != null && taskId !in manuallyScrolledTaskIds && !hasActiveSpeech()) {
            positionChatScrollRequest(defaultChatScrollPosition(messages), animated = true)
        } else {
            null
        }
        _state.update { current ->
            if (msg.id.isNotBlank() && current.messages.any { it.id == msg.id }) {
                current
            } else {
                current.copy(messages = current.messages + msg, chatScrollRequest = request ?: current.chatScrollRequest)
            }
        }
    }

    // ---- Realtime ----

    private fun openRealtime() {
        val token = client.token ?: return
        socket?.stop()
        socket = ConductorSocket(client.baseUrl, token) { ev -> onMainThread { handleRealtime(ev) } }
            .also { it.start() }
    }

    private fun handleRealtime(ev: RealtimeEvent) {
        when (ev) {
            is RealtimeEvent.Connectivity ->
                _state.update { it.copy(realtimeConnected = ev.connected) }

            is RealtimeEvent.Message -> {
                val current = _state.value.selectedTask ?: return
                if (ev.taskId != current.id) return
                addMessage(ev.msg)
                if (isAiReply(ev.msg.role, ev.msg.content)) {
                    _state.update { it.copy(awaitingReply = false) }
                    speakText(ev.msg.content, ev.msg.id)
                }
            }

            is RealtimeEvent.StatusUpdate -> {
                val current = _state.value.selectedTask ?: return
                if (ev.taskId != current.id) return
                if (ev.status == "completed" || ev.status == "killed") {
                    _state.update { it.copy(awaitingReply = false) }
                }
            }
        }
    }

    // ---- Speech ----

    fun startVoice() {
        startVoice(autoSubmitFinal = false)
    }

    fun handleBlankedChatSelect() {
        val s = _state.value
        if (s.screen != Screen.CHAT) return
        if (hasActiveOrQueuedSpeech()) return
        if (s.sttListening) {
            stopVoice()
            return
        }
        if (s.sttCandidate.isNotBlank()) {
            confirmVoiceCandidate()
            return
        }
        startVoice(autoSubmitFinal = true)
    }

    private fun startVoice(autoSubmitFinal: Boolean) {
        if (_state.value.sttListening) return
        if (hasActiveOrQueuedSpeech()) return
        val si = speech ?: SpeechInput(
            context = getApplication(),
            onPartial = { p -> _state.update { it.copy(sttPartial = p, voiceStatus = "正在听") } },
            onFinal = { text ->
                val candidate = text.trim()
                val command = VoiceCommandMatcher.match(candidate)
                val shouldAutoSubmit = autoSubmitCurrentVoiceInput || _state.value.displayBlanked
                autoSubmitCurrentVoiceInput = false
                if (shouldAutoSubmit && candidate.isNotBlank()) {
                    _state.update {
                        it.copy(
                            sttListening = false,
                            sttPartial = "",
                            sttCandidate = "",
                            sttCandidateCommand = null,
                            voiceStatus = null,
                        )
                    }
                    submitVoiceCandidate(candidate, command)
                } else {
                    _state.update {
                        it.copy(
                            sttListening = false,
                            sttPartial = "",
                            sttCandidate = candidate,
                            sttCandidateCommand = command,
                            voiceStatus = if (command == null) "请确认语音内容" else "请确认语音命令",
                        )
                    }
                }
            },
            onError = { msg ->
                autoSubmitCurrentVoiceInput = false
                _state.update { it.copy(sttListening = false, sttPartial = "") }
                if (msg.isNotBlank()) {
                    _state.update {
                        if (msg.startsWith("没有") || msg.startsWith("设备不支持")) {
                            it.copy(info = msg, voiceStatus = msg)
                        } else {
                            it.copy(error = msg, voiceStatus = msg)
                        }
                    }
                }
            },
            onReady = { _state.update { it.copy(voiceStatus = "开始说话") } },
            onBeginning = { _state.update { it.copy(voiceStatus = "正在听") } },
            onEnd = { _state.update { it.copy(voiceStatus = "正在识别") } },
        ).also { speech = it }
        if (!si.available) {
            autoSubmitCurrentVoiceInput = false
            _state.update {
                it.copy(
                    sttAvailable = false,
                    sttListening = false,
                    voiceStatus = "设备不支持语音识别",
                    error = "设备不支持语音识别",
                )
            }
            return
        }
        autoSubmitCurrentVoiceInput = autoSubmitFinal
        _state.update {
            it.copy(
                sttAvailable = true,
                sttListening = true,
                sttPartial = "",
                sttCandidate = "",
                sttCandidateCommand = null,
                error = null,
                info = null,
                voiceStatus = "正在启动语音识别",
            )
        }
        si.start()
    }

    fun stopVoice() {
        if (_state.value.sttListening) {
            _state.update { it.copy(voiceStatus = "正在识别") }
        }
        speech?.stop()
    }

    fun setDisplayBlanked(blanked: Boolean) {
        _state.update { it.copy(displayBlanked = blanked) }
    }

    private fun speakLatestReply() {
        val latest = _state.value.messages.lastOrNull { isAiReply(it.role, it.content) }
        if (latest == null) {
            _state.update { it.copy(info = "暂无可朗读回复", voiceStatus = "暂无可朗读回复") }
            return
        }
        speakText(latest.content, latest.id)
    }

    private fun speakText(text: String, messageId: String? = null) {
        if (text.isBlank()) return
        val item = PendingSpeech(text = text, messageId = messageId)
        if (hasActiveOrQueuedSpeech()) {
            pendingSpeech.addLast(item)
            return
        }
        startSpeech(item)
    }

    private fun startSpeech(item: PendingSpeech) {
        if (!speaker.ready) {
            pendingSpeech.addFirst(item)
            _state.update { it.copy(info = "语音朗读初始化中", voiceStatus = "语音朗读初始化中") }
            return
        }
        activeSpeech = item
        centerMessageForReadout(item.messageId, anchorFraction = 0f)
        _state.update { state ->
            state.copy(
                ttsReadoutMessageId = item.messageId,
                ttsReadoutStartedAtMs = 0L,
                ttsReadoutEstimatedDurationMs = estimateTtsReadoutDurationMs(item.text),
                ttsReadoutRevision = state.ttsReadoutRevision + 1,
                info = null,
                voiceStatus = "正在准备朗读",
            )
        }
        if (!speaker.speak(item.text)) {
            if (activeSpeech === item) {
                activeSpeech = null
                playNextPendingSpeech()
            }
        }
    }

    private fun playNextPendingSpeech() {
        if (hasActiveSpeech()) return
        val next = pendingSpeech.pollFirst() ?: return
        startSpeech(next)
    }

    private fun hasActiveSpeech(): Boolean =
        activeSpeech != null || speaker.speaking || _state.value.ttsSpeaking

    private fun hasActiveOrQueuedSpeech(): Boolean =
        hasActiveSpeech() || pendingSpeech.isNotEmpty()

    private fun handleSpeechOutputStateChanged(speaking: Boolean) {
        if (speaking) {
            _state.update {
                it.copy(
                    ttsSpeaking = true,
                    ttsReadoutStartedAtMs = if (it.ttsReadoutStartedAtMs > 0L) {
                        it.ttsReadoutStartedAtMs
                    } else {
                        System.currentTimeMillis()
                    },
                    voiceStatus = "正在朗读",
                )
            }
            return
        }

        activeSpeech = null
        _state.update { state ->
            val nextStatus = if (state.voiceStatus == "正在朗读" || state.voiceStatus == "正在准备朗读") {
                null
            } else {
                state.voiceStatus
            }
            state.copy(
                ttsSpeaking = false,
                ttsReadoutMessageId = null,
                ttsReadoutStartedAtMs = 0L,
                ttsReadoutEstimatedDurationMs = 0L,
                voiceStatus = nextStatus,
            )
        }
        playNextPendingSpeech()
    }

    private fun stopSpeaking() {
        pendingSpeech.clear()
        activeSpeech = null
        speaker.stop()
        _state.update { state ->
            val status = if (state.voiceStatus == "正在朗读" || state.voiceStatus == "正在准备朗读") {
                null
            } else {
                state.voiceStatus
            }
            state.copy(
                ttsSpeaking = false,
                ttsReadoutMessageId = null,
                ttsReadoutStartedAtMs = 0L,
                ttsReadoutEstimatedDurationMs = 0L,
                voiceStatus = status,
            )
        }
    }

    // ---- Touchpad navigation ----

    fun handleAction(action: HudAction): Boolean {
        return when (action) {
            HudAction.SELECT -> {
                handleSelect()
                true
            }
            HudAction.BACK -> handleBack()
            HudAction.NEXT -> {
                moveFocus(1)
                true
            }
            HudAction.PREVIOUS -> {
                moveFocus(-1)
                true
            }
        }
    }

    fun isChatScreen(): Boolean = _state.value.screen == Screen.CHAT

    fun handleTouchpadScroll(deltaPx: Float): Boolean {
        val state = _state.value
        val taskId = state.selectedTask?.id ?: return false
        if (state.screen != Screen.CHAT || state.messages.isEmpty() || deltaPx == 0f) {
            return false
        }
        manuallyScrolledTaskIds += taskId
        _state.update { it.copy(chatScrollRequest = dragChatScrollRequest(deltaPx)) }
        return true
    }

    private fun handleSelect() {
        when (_state.value.screen) {
            Screen.LOGIN -> startDeviceLogin()
            Screen.PROJECTS -> selectFocusedProject()
            Screen.TASKS -> selectFocusedTask()
            Screen.CHAT -> selectChatAction()
        }
    }

    private fun selectChatAction() {
        val s = _state.value
        if (hasActiveOrQueuedSpeech()) {
            return
        }
        if (s.sttListening) {
            stopVoice()
            return
        }
        if (s.sttCandidate.isNotBlank()) {
            confirmVoiceCandidate()
            return
        }
        startVoice()
    }

    private fun confirmVoiceCandidate() {
        val state = _state.value
        val text = state.sttCandidate.trim()
        val command = state.sttCandidateCommand
        if (text.isBlank()) return
        submitVoiceCandidate(text, command)
    }

    private fun submitVoiceCandidate(text: String, command: VoiceCommand?) {
        _state.update {
            it.copy(
                sttCandidate = "",
                sttCandidateCommand = null,
                sttPartial = "",
                voiceStatus = null,
            )
        }
        if (command != null) {
            executeVoiceCommand(command)
        } else {
            sendText(text)
        }
    }

    private fun clearVoiceCandidate() {
        _state.update {
            it.copy(
                sttCandidate = "",
                sttCandidateCommand = null,
                sttPartial = "",
                voiceStatus = null,
            )
        }
    }

    fun handleBack(): Boolean {
        val current = _state.value.screen
        return when (current) {
            Screen.CHAT -> {
                if (_state.value.sttCandidate.isNotBlank()) {
                    clearVoiceCandidate()
                    return true
                }
                if (hasActiveOrQueuedSpeech()) {
                    stopSpeaking()
                    return true
                }
                stopVoice()
                _state.update {
                    it.copy(
                        screen = Screen.TASKS,
                        selectedTask = null,
                        messages = emptyList(),
                        awaitingReply = false,
                        ttsSpeaking = false,
                        sttCandidate = "",
                        sttCandidateCommand = null,
                        voiceStatus = null,
                    )
                }
                true
            }
            Screen.TASKS -> {
                _state.update { it.copy(screen = Screen.PROJECTS, selectedProject = null, tasks = emptyList()) }
                true
            }
            Screen.PROJECTS, Screen.LOGIN -> false
        }
    }

    private fun moveFocus(delta: Int) {
        _state.update { s ->
            when (s.screen) {
                Screen.LOGIN -> s
                Screen.PROJECTS -> s.copy(
                    focusedProjectIndex = wrapIndex(s.focusedProjectIndex, delta, s.projects.size)
                )
                Screen.TASKS -> s.copy(
                    focusedTaskIndex = wrapIndex(s.focusedTaskIndex, delta, s.tasks.size)
                )
                Screen.CHAT -> requestChatScrollBy(s, delta)
            }
        }
        if (_state.value.screen == Screen.LOGIN) {
            cycleLoginBackend(delta)
        }
    }

    private fun cycleLoginBackend(delta: Int) {
        val options = loginBaseUrlOptions(_state.value.baseUrl)
        val current = options.indexOf(_state.value.baseUrl.trimEnd('/')).let { if (it >= 0) it else 0 }
        val next = options[wrapIndex(current, delta, options.size)]
        if (next == _state.value.baseUrl.trimEnd('/')) return
        deviceLoginJob?.cancel()
        client.baseUrl = next
        prefs.edit().putString("baseUrl", next).apply()
        _state.update {
            it.copy(
                baseUrl = next,
                deviceUserCode = null,
                verificationUri = null,
                verificationUriComplete = null,
                deviceLoginStatus = "已切换服务器",
                error = null,
            )
        }
        startDeviceLogin()
    }

    private fun wrapIndex(current: Int, delta: Int, size: Int): Int {
        if (size <= 0) return 0
        val next = (current + delta) % size
        return if (next < 0) next + size else next
    }

    private fun clampIndex(index: Int, size: Int): Int {
        if (size <= 0) return 0
        return min(max(0, index), size - 1)
    }

    private fun loginBaseUrlOptions(current: String): List<String> {
        val normalized = normalizeBaseUrl(current)
        return listOf(normalized).distinct()
    }

    private fun executeVoiceCommand(command: VoiceCommand) {
        when (command) {
            VoiceCommand.CONTINUE_TASK -> sendText("继续")
            VoiceCommand.SUMMARIZE_PROGRESS -> sendText("总结进展")
            VoiceCommand.NEXT_STEP -> sendText("下一步")
            VoiceCommand.SPEAK_LATEST -> speakLatestReply()
            VoiceCommand.STOP_SPEAKING -> {
                stopSpeaking()
                _state.update { it.copy(info = "已停止朗读", voiceStatus = "已停止朗读") }
            }
        }
    }

    fun rememberChatScrollPosition(index: Int, offset: Int) {
        val taskId = _state.value.selectedTask?.id ?: return
        chatScrollPositionsByTaskId[taskId] = ChatScrollPosition(
            index = index.coerceAtLeast(0),
            offset = offset.coerceAtLeast(0),
        )
    }

    private fun chatScrollPositionForTask(taskId: String, messages: List<ChatMessage>): ChatScrollPosition {
        val saved = chatScrollPositionsByTaskId[taskId]
        return if (taskId in manuallyScrolledTaskIds && saved != null) {
            saved.copy(index = clampChatMessageIndex(saved.index, messages.size), offset = saved.offset.coerceAtLeast(0))
        } else {
            defaultChatScrollPosition(messages)
        }
    }

    private fun requestChatScrollBy(state: UiState, delta: Int): UiState {
        val taskId = state.selectedTask?.id ?: return state
        if (state.messages.isEmpty()) return state
        manuallyScrolledTaskIds += taskId
        return state.copy(chatScrollRequest = deltaChatScrollRequest(delta))
    }

    private fun centerMessageForReadout(messageId: String?, anchorFraction: Float = 0.5f) {
        if (messageId.isNullOrBlank()) return
        _state.update { state ->
            val taskId = state.selectedTask?.id ?: return@update state
            val position = centeredChatScrollPosition(state.messages, messageId)
            chatScrollPositionsByTaskId[taskId] = position
            state.copy(chatScrollRequest = centerChatScrollRequest(position, messageId, anchorFraction))
        }
    }

    private fun positionChatScrollRequest(position: ChatScrollPosition, animated: Boolean = false): ChatScrollRequest =
        ChatScrollRequest(
            id = ++nextChatScrollRequestId,
            kind = ChatScrollKind.POSITION,
            position = position,
            animated = animated,
        )

    private fun deltaChatScrollRequest(delta: Int): ChatScrollRequest =
        ChatScrollRequest(
            id = ++nextChatScrollRequestId,
            kind = ChatScrollKind.DELTA,
            delta = delta,
            animated = true,
        )

    private fun dragChatScrollRequest(deltaPx: Float): ChatScrollRequest =
        ChatScrollRequest(
            id = ++nextChatScrollRequestId,
            kind = ChatScrollKind.DRAG,
            pixelDelta = deltaPx,
        )

    private fun centerChatScrollRequest(
        position: ChatScrollPosition,
        messageId: String,
        anchorFraction: Float,
    ): ChatScrollRequest =
        ChatScrollRequest(
            id = ++nextChatScrollRequestId,
            kind = ChatScrollKind.CENTER,
            position = position,
            messageId = messageId,
            itemAnchorFraction = anchorFraction.coerceIn(0f, 1f),
            animated = true,
        )

    private fun onMainThread(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block()
        else mainHandler.post(block)
    }

    override fun onCleared() {
        deviceLoginJob?.cancel()
        socket?.stop()
        speech?.cancel()
        speaker.shutdown()
        super.onCleared()
    }
}
