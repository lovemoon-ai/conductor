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
    val messageScrollOffset: Int = 0,
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
    val voiceStatus: String? = null,
    val quickReplies: List<String> = listOf("语音输入", "hi", "继续", "总结进展", "下一步", "朗读最新", "停止朗读"),
    val voiceCandidateActions: List<String> = listOf("发送语音", "重说", "取消"),
    val voiceCommandActions: List<String> = listOf("执行命令", "重说", "取消"),
    val focusedQuickReplyIndex: Int = 0,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = app.getSharedPreferences("rokid_conductor", Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val _state = MutableStateFlow(
        UiState(baseUrl = normalizeBaseUrl(prefs.getString("baseUrl", null)))
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val client = ConductorClient(_state.value.baseUrl, prefs.getString("token", null))
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
        },
        onSpeakingChanged = { speaking ->
            _state.update {
                it.copy(
                    ttsSpeaking = speaking,
                    voiceStatus = if (speaking) "正在朗读" else null,
                )
            }
        },
        onError = { msg ->
            _state.update { it.copy(ttsSpeaking = false, error = msg, voiceStatus = null) }
        },
    )
    private var socket: ConductorSocket? = null
    private var speech: SpeechInput? = null
    private var deviceLoginJob: Job? = null

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
        val pid = _state.value.selectedProject?.id ?: return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listTasks(pid) }
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
                messageScrollOffset = 0,
                awaitingReply = false,
                error = null,
            )
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listMessages(t.id) }
                .onSuccess { ms ->
                    _state.update { it.copy(loading = false, messages = ms, messageScrollOffset = 0) }
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    // ---- Chat ----

    fun sendText(content: String) {
        val task = _state.value.selectedTask ?: return
        val text = content.trim()
        if (text.isEmpty()) return
        stopSpeaking()
        _state.update {
            it.copy(
                awaitingReply = true,
                error = null,
                sttPartial = "",
                sttCandidate = "",
                sttCandidateCommand = null,
                voiceStatus = null,
                messageScrollOffset = 0,
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
        _state.update { st ->
            if (msg.id.isNotBlank() && st.messages.any { it.id == msg.id }) {
                st
            } else {
                st.copy(messages = st.messages + msg, messageScrollOffset = 0)
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
                    speakText(ev.msg.content)
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
        if (_state.value.sttListening) return
        stopSpeaking()
        val si = speech ?: SpeechInput(
            context = getApplication(),
            onPartial = { p -> _state.update { it.copy(sttPartial = p, voiceStatus = "正在听") } },
            onFinal = { text ->
                val candidate = text.trim()
                val command = VoiceCommandMatcher.match(candidate)
                _state.update {
                    it.copy(
                        sttListening = false,
                        sttPartial = "",
                        sttCandidate = candidate,
                        sttCandidateCommand = command,
                        focusedQuickReplyIndex = 0,
                        voiceStatus = if (command == null) "请确认语音内容" else "请确认语音命令",
                    )
                }
            },
            onError = { msg ->
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

    private fun speakLatestReply() {
        val latest = _state.value.messages.lastOrNull { isAiReply(it.role, it.content) }
        if (latest == null) {
            _state.update { it.copy(info = "暂无可朗读回复", voiceStatus = "暂无可朗读回复") }
            return
        }
        speakText(latest.content)
    }

    private fun speakText(text: String) {
        if (text.isBlank()) return
        if (!speaker.ready) {
            _state.update { it.copy(info = "语音朗读初始化中", voiceStatus = "语音朗读初始化中") }
            return
        }
        speaker.speak(text)
    }

    private fun stopSpeaking() {
        speaker.stop()
        if (_state.value.ttsSpeaking) {
            _state.update { it.copy(ttsSpeaking = false, voiceStatus = null) }
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
        if (s.sttListening) {
            stopVoice()
            return
        }
        if (s.sttCandidate.isNotBlank()) {
            when (voiceActionsFor(s).getOrNull(s.focusedQuickReplyIndex)) {
                "发送语音", "执行命令" -> confirmVoiceCandidate()
                "重说" -> {
                    clearVoiceCandidate()
                    startVoice()
                }
                "取消" -> clearVoiceCandidate()
            }
            return
        }
        val action = s.quickReplies.getOrNull(s.focusedQuickReplyIndex) ?: return
        when (action) {
            "语音输入" -> startVoice()
            "朗读最新" -> speakLatestReply()
            "停止朗读" -> stopSpeaking()
            else -> sendText(action)
        }
    }

    private fun confirmVoiceCandidate() {
        val state = _state.value
        val text = state.sttCandidate.trim()
        val command = state.sttCandidateCommand
        if (text.isBlank()) return
        _state.update {
            it.copy(
                sttCandidate = "",
                sttCandidateCommand = null,
                sttPartial = "",
                focusedQuickReplyIndex = 0,
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
                focusedQuickReplyIndex = 0,
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
                if (_state.value.ttsSpeaking) {
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
                Screen.CHAT -> s.copy(
                    focusedQuickReplyIndex = wrapIndex(
                        s.focusedQuickReplyIndex,
                        delta,
                        if (s.sttCandidate.isNotBlank()) voiceActionsFor(s).size else s.quickReplies.size,
                    )
                )
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

    private fun voiceActionsFor(state: UiState): List<String> =
        if (state.sttCandidateCommand == null) state.voiceCandidateActions else state.voiceCommandActions

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
