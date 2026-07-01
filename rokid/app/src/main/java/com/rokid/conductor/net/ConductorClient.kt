package com.rokid.conductor.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

private fun JSONObject.optCleanString(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return optString(name)
        .trim()
        .takeUnless { it.isBlank() || it.equals("null", ignoreCase = true) }
}

private fun JSONObject.optCleanString(vararg names: String): String? {
    for (name in names) {
        optCleanString(name)?.let { return it }
    }
    return null
}

private fun JSONObject.optBooleanOrNull(name: String): Boolean? {
    if (!has(name) || isNull(name)) return null
    return when (val value = opt(name)) {
        is Boolean -> value
        is Number -> value.toInt() != 0
        is String -> when (value.trim().lowercase()) {
            "true", "1", "yes" -> true
            "false", "0", "no" -> false
            else -> null
        }
        else -> null
    }
}

private fun JSONObject.optBooleanOrNull(vararg names: String): Boolean? {
    for (name in names) {
        optBooleanOrNull(name)?.let { return it }
    }
    return null
}

private fun JSONObject.optObject(name: String): JSONObject? {
    if (!has(name) || isNull(name)) return null
    return when (val value = opt(name)) {
        is JSONObject -> value
        is String -> runCatching { JSONObject(value) }.getOrNull()
        else -> null
    }
}

/** A Conductor project. */
data class Project(
    val id: String,
    val name: String,
    val isDefault: Boolean,
    val daemonHost: String? = null,
    val gitRemoteUrl: String? = null,
    val hidden: Boolean = false,
    val mergeOptOut: Boolean = false,
    val memberIds: List<String> = listOf(id),
    val daemonHosts: List<String> = daemonHost?.let { listOf(it) } ?: emptyList(),
)

/** A Conductor task. */
data class TaskItem(
    val id: String,
    val projectId: String,
    val title: String,
    val status: String,
    val taskType: String,
    val pinnedAt: String? = null,
    val hidden: Boolean = false,
)

/** A single conversation message. */
data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val createdAt: String,
)

data class DeviceAuthStartResult(
    val deviceCode: String,
    val userCode: String,
    val verificationUri: String,
    val verificationUriComplete: String,
    val expiresIn: Int,
    val interval: Int,
)

data class DeviceAuthPollResult(
    val status: String,
    val agentToken: String?,
    val backendUrl: String?,
    val websocketUrl: String?,
    val message: String?,
)

class ConductorException(message: String) : Exception(message)

internal fun canMergeProjectsForRokid(a: Project, b: Project): Boolean {
    if (a.id == b.id) return true
    if (a.name != b.name) return false
    if (a.mergeOptOut || b.mergeOptOut) return false
    val aHost = a.daemonHost?.trim().orEmpty()
    val bHost = b.daemonHost?.trim().orEmpty()
    if (aHost.isBlank() || bHost.isBlank()) return false
    if (aHost == bHost) return false
    val aRemote = a.gitRemoteUrl?.trim()?.lowercase().orEmpty()
    val bRemote = b.gitRemoteUrl?.trim()?.lowercase().orEmpty()
    if (aRemote.isNotBlank() && bRemote.isNotBlank() && aRemote != bRemote) return false
    return true
}

internal fun groupProjectsForRokid(projects: List<Project>): List<Project> {
    val groups = mutableListOf<Project>()
    val groupedIds = mutableSetOf<String>()
    for (i in projects.indices) {
        val project = projects[i]
        if (!groupedIds.add(project.id)) continue

        val members = mutableListOf(project)
        for (j in i + 1 until projects.size) {
            val candidate = projects[j]
            if (candidate.id in groupedIds) continue
            if (canMergeProjectsForRokid(project, candidate)) {
                members += candidate
                groupedIds += candidate.id
            }
        }

        groups += if (members.size == 1) {
            project.copy(
                memberIds = listOf(project.id),
                daemonHosts = project.daemonHost?.let { listOf(it) } ?: emptyList(),
            )
        } else {
            val sortedIds = members.map { it.id }.sorted()
            val daemonHosts = members.mapNotNull { it.daemonHost?.trim()?.takeIf(String::isNotBlank) }
                .distinct()
            project.copy(
                id = "merged:${project.name}:${sortedIds.joinToString("|")}",
                isDefault = members.any { it.isDefault },
                daemonHost = daemonHosts.firstOrNull(),
                memberIds = members.map { it.id },
                daemonHosts = daemonHosts,
            )
        }
    }
    return groups
}

internal fun orderTasksForRokid(tasks: List<TaskItem>): List<TaskItem> =
    tasks
        .filterNot { it.hidden }
        .mapIndexed { index, task ->
            val pinnedTime = task.pinnedAt?.let { DateParser.parseIsoMillis(it) }
            IndexedTask(task, index, pinnedTime)
        }
        .sortedWith { left, right ->
            when {
                left.pinnedAt != null && right.pinnedAt != null -> {
                    val delta = right.pinnedAt.compareTo(left.pinnedAt)
                    if (delta != 0) delta else left.index.compareTo(right.index)
                }
                left.pinnedAt != null -> -1
                right.pinnedAt != null -> 1
                else -> left.index.compareTo(right.index)
            }
        }
        .map { it.task }

private data class IndexedTask(
    val task: TaskItem,
    val index: Int,
    val pinnedAt: Long?,
)

private object DateParser {
    fun parseIsoMillis(value: String): Long? =
        runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()
}

/**
 * Thin client over the Conductor backend REST API.
 * See PLAN.md for the verified endpoint contract.
 */
class ConductorClient(
    @Volatile var baseUrl: String,
    @Volatile var token: String? = null,
) {
    private val json = "application/json; charset=utf-8".toMediaType()
    private val wav = "audio/wav".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val websocketHttp = http.newBuilder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private fun url(path: String): String = baseUrl.trimEnd('/') + path

    private fun websocketUrl(path: String, authToken: String): String {
        val trimmed = baseUrl.trimEnd('/')
        val scheme = if (trimmed.startsWith("https", ignoreCase = true)) "wss" else "ws"
        val host = trimmed.substringAfter("://", trimmed)
        val encodedToken = URLEncoder.encode(authToken, Charsets.UTF_8.name())
        return "$scheme://$host$path?token=$encodedToken"
    }

    private fun newRequest(path: String): Request.Builder {
        val b = Request.Builder().url(url(path))
        token?.let { b.header("Authorization", "Bearer $it") }
        return b
    }

    private fun execGet(path: String): String = exec(newRequest(path).get().build())

    private fun execJson(path: String, method: String, body: JSONObject): String {
        val req = newRequest(path).method(method, body.toString().toRequestBody(json)).build()
        return exec(req)
    }

    private fun exec(req: Request): String {
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw ConductorException(
                    if (!msg.isNullOrBlank()) msg else "HTTP ${resp.code}: ${text.take(200)}"
                )
            }
            return text
        }
    }

    // ---- Auth ----

    suspend fun startDeviceAuthorization(): DeviceAuthStartResult = withContext(Dispatchers.IO) {
        val normalizedBaseUrl = baseUrl.trimEnd('/')
        val body = JSONObject()
            .put("cli_version", "rokid-android-1.0")
            .put("hostname", "rokid-glasses")
            .put("platform", "rokid-glasses")
            .put("backend_url", normalizedBaseUrl)
        val obj = JSONObject(execJson("/api/auth/device/start", "POST", body))
        DeviceAuthStartResult(
            deviceCode = obj.getString("device_code"),
            userCode = obj.getString("user_code"),
            verificationUri = "$normalizedBaseUrl/activate",
            verificationUriComplete = "$normalizedBaseUrl/activate?user_code=" + obj.getString("user_code"),
            expiresIn = obj.optInt("expires_in", 600),
            interval = obj.optInt("interval", 3).coerceAtLeast(1),
        )
    }

    suspend fun pollDeviceAuthorization(deviceCode: String): DeviceAuthPollResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("device_code", deviceCode)
            val obj = JSONObject(execJson("/api/auth/device/poll", "POST", body))
            DeviceAuthPollResult(
                status = obj.optString("status", "pending"),
                agentToken = obj.optCleanString("agent_token"),
                backendUrl = obj.optCleanString("backend_url"),
                websocketUrl = obj.optCleanString("websocket_url"),
                message = obj.optCleanString("message") ?: obj.optCleanString("error"),
            )
        }

    suspend fun me(): String = withContext(Dispatchers.IO) {
        val obj = JSONObject(execGet("/api/auth/me"))
        val user = obj.optJSONObject("user")
        user?.optCleanString("phone")
            ?: user?.optCleanString("email")
            ?: "user"
    }

    // ---- Projects ----

    suspend fun listProjects(): List<Project> = withContext(Dispatchers.IO) {
        val arr = JSONArray(execGet("/api/projects"))
        val projects = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            val hidden = o.optBooleanOrNull("hidden", "is_hidden")
                ?: (o.optCleanString("hiddenAt", "hidden_at") != null)
            Project(
                id = o.getString("id"),
                name = o.optString("name").ifBlank { "(untitled)" },
                isDefault = o.optBooleanOrNull("isDefault", "is_default") ?: false,
                daemonHost = o.optCleanString("daemonHost", "daemon_host"),
                gitRemoteUrl = o.optCleanString("gitRemoteUrl", "git_remote_url"),
                hidden = hidden,
                mergeOptOut = o.optBooleanOrNull("mergeOptOut", "merge_opt_out") ?: false,
            )
        }
        groupProjectsForRokid(projects.filterNot { it.hidden })
            .sortedByDescending { it.isDefault }
    }

    // ---- Tasks ----

    suspend fun listTasks(projectId: String): List<TaskItem> = listTasks(listOf(projectId))

    suspend fun listTasks(projectIds: List<String>): List<TaskItem> = withContext(Dispatchers.IO) {
        val ids = projectIds.map { it.trim() }.filter { it.isNotBlank() }.distinct()
        if (ids.isEmpty()) return@withContext emptyList()
        val query = if (ids.size == 1) {
            "project_id=${URLEncoder.encode(ids.first(), Charsets.UTF_8.name())}"
        } else {
            "project_ids=${URLEncoder.encode(ids.joinToString(","), Charsets.UTF_8.name())}"
        }
        val arr = JSONArray(execGet("/api/tasks?$query&recover_stale=1"))
        orderTasksForRokid((0 until arr.length()).map { i -> parseTask(arr.getJSONObject(i)) })
    }

    suspend fun createTask(projectId: String, title: String, initialContent: String?): TaskItem =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("project_id", projectId)
                .put("title", title)
                .put("task_type", "ai_task")
            if (!initialContent.isNullOrBlank()) body.put("initial_content", initialContent)
            parseTask(JSONObject(execJson("/api/tasks", "POST", body)))
        }

    private fun parseTask(o: JSONObject): TaskItem = TaskItem(
        id = o.getString("id"),
        projectId = o.optCleanString("projectId", "project_id").orEmpty(),
        title = o.optString("title").ifBlank { "(untitled task)" },
        status = o.optString("status", "unknown"),
        taskType = o.optString("task_type", "ai_task"),
        pinnedAt = o.optObject("metadata")?.optCleanString("pinnedAt", "pinned_at"),
        hidden = (o.optBooleanOrNull("hidden", "is_hidden") ?: false) ||
            o.optString("status", "").equals("hide", ignoreCase = true) ||
            o.optString("status", "").equals("hidden", ignoreCase = true),
    )

    // ---- Messages ----

    suspend fun listMessages(taskId: String): List<ChatMessage> = withContext(Dispatchers.IO) {
        val arr = JSONArray(execGet("/api/tasks/$taskId/messages"))
        (0 until arr.length()).map { i -> parseMessage(arr.getJSONObject(i)) }
    }

    suspend fun sendUserMessage(taskId: String, content: String, clientRequestId: String) =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("content", content)
                .put("role", "user")
                .put("clientRequestId", clientRequestId)
            parseMessage(JSONObject(execJson("/api/tasks/$taskId/messages", "POST", body)))
        }

    suspend fun transcribeSpeech(wavBytes: ByteArray, languageTag: String?): String =
        withContext(Dispatchers.IO) {
            val bodyBuilder = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", "speech.wav", wavBytes.toRequestBody(wav))
            if (!languageTag.isNullOrBlank()) {
                bodyBuilder.addFormDataPart("language", languageTag)
            }
            val req = newRequest("/api/speech/transcribe")
                .post(bodyBuilder.build())
                .build()
            JSONObject(exec(req)).optString("text").trim()
        }

    suspend fun openSpeechStream(languageTag: String?, sampleRate: Int): SpeechStream =
        withContext(Dispatchers.IO) {
            val authToken = token?.trim().takeUnless { it.isNullOrBlank() }
                ?: throw ConductorException("Token required")
            val ready = CompletableDeferred<Unit>()
            val result = CompletableDeferred<String>()

            fun fail(message: String) {
                val error = ConductorException(message)
                if (!ready.isCompleted) ready.completeExceptionally(error)
                if (!result.isCompleted) result.completeExceptionally(error)
            }

            val req = Request.Builder()
                .url(websocketUrl("/ws/speech", authToken))
                .build()
            val webSocket = websocketHttp.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val payload = JSONObject().put("sample_rate", sampleRate)
                    if (!languageTag.isNullOrBlank()) {
                        payload.put("language", languageTag)
                    }
                    val start = JSONObject()
                        .put("type", "start")
                        .put("payload", payload)
                    if (!webSocket.send(start.toString())) {
                        fail("speech stream start failed")
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
                    val payload = obj.optJSONObject("payload")
                    when (obj.optString("type")) {
                        "ready" -> {
                            if (!ready.isCompleted) ready.complete(Unit)
                        }
                        "result" -> {
                            if (!result.isCompleted) {
                                result.complete(payload?.optString("text").orEmpty().trim())
                            }
                        }
                        "error" -> {
                            fail(payload?.optString("message").orEmpty().ifBlank { "speech stream failed" })
                        }
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    fail(t.message ?: "speech stream failed")
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (!result.isCompleted) {
                        result.completeExceptionally(
                            ConductorException(reason.ifBlank { "speech stream closed $code" }),
                        )
                    }
                }
            })
            val stream = SpeechStream(webSocket, result)
            try {
                withTimeout(5_000) {
                    ready.await()
                }
            } catch (t: TimeoutCancellationException) {
                stream.cancel()
                throw ConductorException(t.message ?: "speech stream ready timeout")
            } catch (t: ConductorException) {
                stream.cancel()
                throw t
            }
            stream
        }

    companion object {
        fun parseMessage(o: JSONObject): ChatMessage = ChatMessage(
            id = o.optString("id"),
            role = o.optString("role", "assistant"),
            content = o.optString("content"),
            createdAt = if (o.has("createdAt")) o.optString("createdAt") else o.optString("created_at"),
        )
    }
}

class SpeechStream internal constructor(
    private val webSocket: WebSocket,
    private val result: CompletableDeferred<String>,
) {
    @Volatile private var closed = false

    fun sendPcm(bytes: ByteArray): Boolean {
        if (closed || bytes.isEmpty()) return !closed
        return webSocket.send(bytes.toByteString())
    }

    suspend fun finish(): String {
        if (closed) throw ConductorException("speech stream closed")
        closed = true
        val finish = JSONObject().put("type", "finish").toString()
        if (!webSocket.send(finish)) {
            throw ConductorException("speech stream finish failed")
        }
        return try {
            withTimeout(35_000) {
                result.await()
            }
        } finally {
            webSocket.close(1000, "done")
        }
    }

    fun cancel() {
        closed = true
        webSocket.close(1000, "cancel")
    }
}
