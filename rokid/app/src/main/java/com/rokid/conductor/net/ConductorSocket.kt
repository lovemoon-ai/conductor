package com.rokid.conductor.net

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Realtime events from the Conductor `/ws/app` gateway, already scoped to a task by the caller. */
sealed interface RealtimeEvent {
    data class Message(val msg: ChatMessage, val taskId: String) : RealtimeEvent
    data class StatusUpdate(val taskId: String, val status: String) : RealtimeEvent
    data class Connectivity(val connected: Boolean, val detail: String) : RealtimeEvent
}

/**
 * Connects a raw WebSocket to `ws(s)://host/ws/app?token=<bearer>` and emits chat-relevant events.
 * Auto-reconnects with a fixed backoff while [start]ed.
 */
class ConductorSocket(
    private val baseUrl: String,
    private val token: String,
    private val onEvent: (RealtimeEvent) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var running = false

    private fun wsUrl(): String {
        val scheme = if (baseUrl.startsWith("https")) "wss" else "ws"
        val host = baseUrl.substringAfter("://").trimEnd('/')
        return "$scheme://$host/ws/app?token=$token"
    }

    fun start() {
        if (running) return
        running = true
        connect()
    }

    private fun connect() {
        if (!running) return
        val req = Request.Builder().url(wsUrl()).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "ws open")
                onEvent(RealtimeEvent.Connectivity(true, "realtime connected"))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handle(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "ws failure: ${t.message}")
                onEvent(RealtimeEvent.Connectivity(false, t.message ?: "disconnected"))
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "ws closed $code $reason")
                onEvent(RealtimeEvent.Connectivity(false, "closed $code"))
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        ws = null
        if (!running) return
        Thread {
            try { Thread.sleep(2500) } catch (_: InterruptedException) {}
            connect()
        }.start()
    }

    private fun handle(text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        val type = obj.optString("type")
        val payload = obj.optJSONObject("payload") ?: return
        when (type) {
            "task_user_message", "task_sdk_message" -> {
                val taskId = payload.optString("task_id").ifBlank { payload.optString("taskId") }
                onEvent(RealtimeEvent.Message(ConductorClient.parseMessage(payload), taskId))
            }
            "task_status_update" -> {
                val taskId = payload.optString("task_id").ifBlank { payload.optString("taskId") }
                onEvent(RealtimeEvent.StatusUpdate(taskId, payload.optString("status")))
            }
        }
    }

    fun stop() {
        running = false
        ws?.close(1000, "bye")
        ws = null
    }

    companion object {
        private const val TAG = "ConductorSocket"
    }
}
