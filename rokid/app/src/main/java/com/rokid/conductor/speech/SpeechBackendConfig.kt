package com.rokid.conductor.speech

import android.content.Context
import com.rokid.conductor.net.ConductorClient

internal object SpeechBackendConfig {
    private const val PrefsName = "rokid_conductor"
    private const val ProductionBaseUrl = "https://conductor.conductor-ai.top"

    fun clientFromPrefs(context: Context): ConductorClient {
        val prefs = context.getSharedPreferences(PrefsName, Context.MODE_PRIVATE)
        return ConductorClient(
            baseUrl = normalizeBaseUrl(prefs.getString("baseUrl", null)),
            token = prefs.getString("token", null)?.trim()?.takeIf { it.isNotBlank() },
        )
    }

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
}
