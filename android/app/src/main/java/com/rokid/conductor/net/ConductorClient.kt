package com.rokid.conductor.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** A Conductor project. */
data class Project(
    val id: String,
    val name: String,
    val isDefault: Boolean,
)

/** A Conductor task. */
data class TaskItem(
    val id: String,
    val projectId: String,
    val title: String,
    val status: String,
    val taskType: String,
)

/** A single conversation message. */
data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val createdAt: String,
)

data class AuthResult(val token: String, val userLabel: String)

class ConductorException(message: String) : Exception(message)

/**
 * Thin client over the Conductor backend REST API.
 * See PLAN.md for the verified endpoint contract.
 */
class ConductorClient(
    @Volatile var baseUrl: String,
    @Volatile var token: String? = null,
) {
    private val json = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun url(path: String): String = baseUrl.trimEnd('/') + path

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

    suspend fun requestCode(phone: String, countryCode: String) = withContext(Dispatchers.IO) {
        val body = JSONObject().put("phone", phone).put("countryCode", countryCode)
        execJson("/api/auth/request-code", "POST", body)
        Unit
    }

    /** Verify OTP. Tries login first, then register (auto-creates the account + default project). */
    suspend fun loginOrRegister(phone: String, countryCode: String, code: String): AuthResult =
        withContext(Dispatchers.IO) {
            val identifier = countryCode + phone
            val loginBody = JSONObject().put("identifier", identifier).put("code", code)
            val text = try {
                execJson("/api/auth/login", "POST", loginBody)
            } catch (e: ConductorException) {
                // Account not found -> register with the same code.
                val regBody = JSONObject()
                    .put("phone", phone).put("countryCode", countryCode).put("code", code)
                execJson("/api/auth/register", "POST", regBody)
            }
            val obj = JSONObject(text)
            val tok = obj.optString("token")
            if (tok.isNullOrBlank()) throw ConductorException("No token in auth response")
            token = tok
            val user = obj.optJSONObject("user")
            val label = user?.optString("phone")?.takeIf { it.isNotBlank() }
                ?: user?.optString("email")?.takeIf { it.isNotBlank() }
                ?: identifier
            AuthResult(tok, label)
        }

    suspend fun me(): String = withContext(Dispatchers.IO) {
        val obj = JSONObject(execGet("/api/auth/me"))
        val user = obj.optJSONObject("user")
        user?.optString("phone")?.takeIf { it.isNotBlank() }
            ?: user?.optString("email")?.takeIf { it.isNotBlank() }
            ?: "user"
    }

    // ---- Projects ----

    suspend fun listProjects(): List<Project> = withContext(Dispatchers.IO) {
        val arr = JSONArray(execGet("/api/projects"))
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Project(
                id = o.getString("id"),
                name = o.optString("name").ifBlank { "(untitled)" },
                isDefault = o.optBoolean("is_default", false),
            )
        }.sortedByDescending { it.isDefault }
    }

    // ---- Tasks ----

    suspend fun listTasks(projectId: String): List<TaskItem> = withContext(Dispatchers.IO) {
        val arr = JSONArray(execGet("/api/tasks?project_id=$projectId"))
        (0 until arr.length()).map { i -> parseTask(arr.getJSONObject(i)) }
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
        projectId = o.optString("project_id"),
        title = o.optString("title").ifBlank { "(untitled task)" },
        status = o.optString("status", "unknown"),
        taskType = o.optString("task_type", "ai_task"),
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

    companion object {
        fun parseMessage(o: JSONObject): ChatMessage = ChatMessage(
            id = o.optString("id"),
            role = o.optString("role", "assistant"),
            content = o.optString("content"),
            createdAt = if (o.has("createdAt")) o.optString("createdAt") else o.optString("created_at"),
        )
    }
}
