package com.rokid.conductor

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.conductor.glasses.GlassDevice
import com.rokid.conductor.glasses.GlassesListener
import com.rokid.conductor.glasses.GlassesManager
import com.rokid.conductor.net.ChatMessage
import com.rokid.conductor.net.ConductorClient
import com.rokid.conductor.net.ConductorSocket
import com.rokid.conductor.net.Project
import com.rokid.conductor.net.RealtimeEvent
import com.rokid.conductor.net.TaskItem
import com.rokid.conductor.speech.SpeechInput
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

enum class Screen { LOGIN, PROJECTS, TASKS, CHAT }

data class UiState(
    val screen: Screen = Screen.LOGIN,
    val baseUrl: String = "https://conductor-ai.top",
    val phone: String = "",
    val countryCode: String = "+86",
    val codeSent: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val info: String? = null,
    val userLabel: String? = null,
    val projects: List<Project> = emptyList(),
    val selectedProject: Project? = null,
    val tasks: List<TaskItem> = emptyList(),
    val selectedTask: TaskItem? = null,
    val messages: List<ChatMessage> = emptyList(),
    val awaitingReply: Boolean = false,
    val glassesConnected: Boolean = false,
    val glassesStatus: String = "眼镜未连接",
    val glassesDevices: List<GlassDevice> = emptyList(),
    val realtimeConnected: Boolean = false,
    val sttListening: Boolean = false,
    val sttPartial: String = "",
)

class AppViewModel(app: Application) : AndroidViewModel(app), GlassesListener {

    private val prefs = app.getSharedPreferences("rokid_conductor", Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val _state = MutableStateFlow(
        UiState(
            baseUrl = prefs.getString("baseUrl", "https://conductor-ai.top")!!,
            phone = prefs.getString("phone", "")!!,
            countryCode = prefs.getString("countryCode", "+86")!!,
        )
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val client = ConductorClient(_state.value.baseUrl, prefs.getString("token", null))
    private val glasses = GlassesManager(app.applicationContext, this)
    private var socket: ConductorSocket? = null
    private var speech: SpeechInput? = null

    init {
        // Resume an existing session if we have a stored token.
        client.token?.let { restoreSession() }
    }

    private fun restoreSession() = viewModelScope.launch {
        _state.update { it.copy(loading = true) }
        runCatching { client.me() }
            .onSuccess { label ->
                _state.update { it.copy(loading = false, userLabel = label, screen = Screen.PROJECTS) }
                openRealtime()
                loadProjects()
            }
            .onFailure {
                // Token invalid/expired -> back to login.
                client.token = null
                prefs.edit().remove("token").apply()
                _state.update { it.copy(loading = false, screen = Screen.LOGIN) }
            }
    }

    // ---- Login form ----

    fun setBaseUrl(v: String) = _state.update { it.copy(baseUrl = v) }
    fun setPhone(v: String) = _state.update { it.copy(phone = v.filter { c -> c.isDigit() }) }
    fun setCountryCode(v: String) = _state.update { it.copy(countryCode = v) }
    fun clearMessages() = _state.update { it.copy(error = null, info = null) }

    fun requestCode() {
        val s = _state.value
        if (s.phone.isBlank()) {
            _state.update { it.copy(error = "请输入手机号") }
            return
        }
        client.baseUrl = s.baseUrl.trim()
        persistLoginFields()
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null, info = null) }
            runCatching { client.requestCode(s.phone, s.countryCode) }
                .onSuccess {
                    _state.update {
                        it.copy(loading = false, codeSent = true, info = "验证码已发送")
                    }
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = e.message ?: "发送失败") }
                }
        }
    }

    fun verifyCode(code: String) {
        val s = _state.value
        if (code.isBlank()) {
            _state.update { it.copy(error = "请输入验证码") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.loginOrRegister(s.phone, s.countryCode, code.trim()) }
                .onSuccess { res ->
                    prefs.edit().putString("token", res.token).apply()
                    _state.update {
                        it.copy(loading = false, userLabel = res.userLabel, screen = Screen.PROJECTS)
                    }
                    openRealtime()
                    loadProjects()
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = e.message ?: "登录失败") }
                }
        }
    }

    fun logout() {
        socket?.stop(); socket = null
        client.token = null
        prefs.edit().remove("token").apply()
        _state.update {
            UiState(baseUrl = it.baseUrl, phone = it.phone, countryCode = it.countryCode)
        }
    }

    private fun persistLoginFields() {
        prefs.edit()
            .putString("baseUrl", _state.value.baseUrl.trim())
            .putString("phone", _state.value.phone)
            .putString("countryCode", _state.value.countryCode)
            .apply()
    }

    // ---- Projects ----

    fun loadProjects() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listProjects() }
                .onSuccess { ps -> _state.update { it.copy(loading = false, projects = ps) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun selectProject(p: Project) {
        _state.update { it.copy(selectedProject = p, screen = Screen.TASKS, tasks = emptyList()) }
        loadTasks()
    }

    fun loadTasks() {
        val pid = _state.value.selectedProject?.id ?: return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listTasks(pid) }
                .onSuccess { ts -> _state.update { it.copy(loading = false, tasks = ts) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun createTask(title: String, initialContent: String?) {
        val pid = _state.value.selectedProject?.id ?: return
        if (title.isBlank()) return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.createTask(pid, title.trim(), initialContent?.trim()) }
                .onSuccess { t ->
                    _state.update { it.copy(loading = false) }
                    loadTasks()
                    selectTask(t)
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    // ---- Chat ----

    fun selectTask(t: TaskItem) {
        _state.update { it.copy(selectedTask = t, screen = Screen.CHAT, messages = emptyList()) }
        glasses.openAiChat()
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { client.listMessages(t.id) }
                .onSuccess { ms ->
                    _state.update { it.copy(loading = false, messages = ms) }
                    ms.lastOrNull { isAiReply(it.role, it.content) }
                        ?.let { glasses.showAiReply(it.content) }
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun sendText(content: String) {
        val task = _state.value.selectedTask ?: return
        val text = content.trim()
        if (text.isEmpty()) return
        glasses.showUserText(text)
        glasses.notifyThinking()
        _state.update { it.copy(awaitingReply = true, error = null, sttPartial = "") }
        viewModelScope.launch {
            runCatching { client.sendUserMessage(task.id, text, UUID.randomUUID().toString()) }
                .onSuccess { msg -> addMessage(msg) }
                .onFailure { e ->
                    glasses.notifyError()
                    _state.update {
                        it.copy(awaitingReply = false, error = e.message ?: "发送失败")
                    }
                }
        }
    }

    /** Substantive AI output worth showing on the glasses (filters agent lifecycle notes). */
    private fun isAiReply(role: String, content: String): Boolean {
        if (role == "user" || content.isBlank()) return false
        val c = content.lowercase()
        val noise = c.contains("session started") || c.contains("session ready") ||
            c.contains("session resumed")
        return !noise
    }

    private fun addMessage(msg: ChatMessage) {
        _state.update { st ->
            if (msg.id.isNotBlank() && st.messages.any { it.id == msg.id }) st
            else st.copy(messages = st.messages + msg)
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
                    glasses.showAiReply(ev.msg.content)
                    _state.update { it.copy(awaitingReply = false) }
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

    // ---- Glasses ----

    fun refreshGlassDevices() {
        _state.update { it.copy(glassesDevices = glasses.listCandidateDevices()) }
    }

    fun connectGlasses(mac: String) = glasses.connect(mac)
    fun disconnectGlasses() = glasses.disconnect()

    override fun onStatus(connected: Boolean, text: String) = onMainThread {
        _state.update { it.copy(glassesConnected = connected, glassesStatus = text) }
        if (connected && _state.value.screen == Screen.CHAT) glasses.openAiChat()
    }

    override fun onAiKeyDown() = onMainThread { startVoice() }
    override fun onAiKeyUp() = onMainThread { stopVoice() }
    override fun onAiExit() = onMainThread { stopVoice() }

    // ---- Speech (must run on the main thread) ----

    fun startVoice() {
        if (_state.value.sttListening) return
        val si = speech ?: SpeechInput(
            context = getApplication(),
            onPartial = { p -> _state.update { it.copy(sttPartial = p) } },
            onFinal = { text ->
                _state.update { it.copy(sttListening = false, sttPartial = "") }
                sendText(text)
            },
            onError = { msg ->
                _state.update { it.copy(sttListening = false, sttPartial = "") }
                if (msg.isNotBlank()) _state.update { it.copy(error = msg) }
            },
        ).also { speech = it }
        _state.update { it.copy(sttListening = true, sttPartial = "", error = null) }
        si.start()
    }

    fun stopVoice() {
        speech?.stop()
    }

    private fun onMainThread(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block()
        else mainHandler.post(block)
    }

    fun goBack() {
        _state.update {
            when (it.screen) {
                Screen.CHAT -> {
                    glasses.closeScene()
                    it.copy(screen = Screen.TASKS, selectedTask = null, messages = emptyList())
                }
                Screen.TASKS -> it.copy(screen = Screen.PROJECTS, selectedProject = null)
                else -> it
            }
        }
    }

    override fun onCleared() {
        socket?.stop()
        speech?.cancel()
        super.onCleared()
    }
}
