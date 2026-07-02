package com.rokid.conductor

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.lifecycleScope
import com.rokid.conductor.ui.RokidConductorApp
import kotlin.math.abs
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val viewModel: AppViewModel by viewModels()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {}

    private val swipeThresholdPx by lazy { 64f * resources.displayMetrics.density }
    private val wakeTapSlopPx by lazy { ViewConfiguration.get(this).scaledTouchSlop.toFloat() }
    private var lastDirectionalActionAtMs = 0L
    private var lastSelectActionAtMs = 0L
    private var conversationWakeLock: PowerManager.WakeLock? = null
    private var displayBlanked by mutableStateOf(false)
    private var previousScreenBrightness: Float? = null
    private var suppressTouchUntilUp = false
    private var wakeTouchDownX = 0f
    private var wakeTouchDownY = 0f
    private var wakeTouchDownAtMs = 0L
    private var lastDisplayActivitySnapshot: DisplayActivitySnapshot? = null
    private val manualBlankGestureTracker = ManualDisplayBlankGestureTracker()
    private val inactivityHandler = Handler(Looper.getMainLooper())
    private val inactivityBlankRunnable = Runnable { blankDisplay() }

    private val gestureDetector by lazy {
        GestureDetector(
            this,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onDown(e: MotionEvent): Boolean = true

                override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                    if (displayBlanked) return true
                    resetManualBlankGestureTracker()
                    return dispatchHudAction(HudAction.SELECT)
                }

                override fun onDoubleTap(e: MotionEvent): Boolean {
                    if (displayBlanked) return true
                    resetManualBlankGestureTracker()
                    if (!viewModel.handleBack()) finish()
                    return true
                }

                override fun onScroll(
                    e1: MotionEvent?,
                    e2: MotionEvent,
                    distanceX: Float,
                    distanceY: Float
                ): Boolean {
                    if (displayBlanked) return true
                    if (!viewModel.isChatScreen()) return false
                    if (abs(distanceX) < 1f || abs(distanceX) <= abs(distanceY)) return false
                    return viewModel.handleTouchpadScroll(-distanceX * TouchpadScrollScale)
                }

                override fun onFling(
                    e1: MotionEvent?,
                    e2: MotionEvent,
                    velocityX: Float,
                    velocityY: Float
                ): Boolean {
                    if (displayBlanked) return true
                    val start = e1 ?: return false
                    val dx = e2.x - start.x
                    val dy = e2.y - start.y
                    if (abs(dx) < swipeThresholdPx || abs(dx) <= abs(dy)) return false
                    if (recordManualBlankSwipe(directionFromDx(dx), e2.eventTime)) return true
                    if (viewModel.isChatScreen()) return true
                    dispatchHudAction(if (dx > 0f) HudAction.NEXT else HudAction.PREVIOUS)
                    return true
                }
            }
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        acquireConversationWakeLock()
        viewModel.setDisplayBlanked(false)
        hideSystemBars()
        requestRuntimePermissions()
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (!viewModel.handleBack()) finish()
                }
            }
        )
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Box(Modifier.fillMaxSize()) {
                    RokidConductorApp(viewModel)
                    if (displayBlanked) {
                        Box(Modifier.fillMaxSize().background(Color.Black))
                    }
                }
            }
        }
        observeDisplayActivity()
        scheduleInactivityBlank()
    }

    override fun onDestroy() {
        inactivityHandler.removeCallbacks(inactivityBlankRunnable)
        restoreDisplayIfBlanked()
        releaseConversationWakeLock()
        super.onDestroy()
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (displayBlanked) {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                wakeTouchDownX = event.x
                wakeTouchDownY = event.y
                wakeTouchDownAtMs = event.eventTime
                restoreDisplayIfBlanked()
                suppressTouchUntilUp = true
                scheduleInactivityBlank()
            }
            return true
        }
        if (suppressTouchUntilUp) {
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                suppressTouchUntilUp = false
                if (isWakeTap(event) && viewModel.isChatScreen()) {
                    viewModel.handleBlankedChatSelect()
                }
            } else if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
                suppressTouchUntilUp = false
            }
            scheduleInactivityBlank()
            return true
        }
        scheduleInactivityBlank()
        val handledByGesture = gestureDetector.onTouchEvent(event)
        return handledByGesture || super.dispatchTouchEvent(event)
    }

    private fun isWakeTap(event: MotionEvent): Boolean {
        val durationMs = event.eventTime - wakeTouchDownAtMs
        if (durationMs > ViewConfiguration.getLongPressTimeout()) return false
        return abs(event.x - wakeTouchDownX) <= wakeTapSlopPx &&
            abs(event.y - wakeTouchDownY) <= wakeTapSlopPx
    }

    @SuppressLint("RestrictedApi")
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (displayBlanked) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                restoreDisplayIfBlanked()
                scheduleInactivityBlank()
                if (isSelectKey(event.keyCode) && viewModel.isChatScreen()) {
                    viewModel.handleBlankedChatSelect()
                }
            }
            return true
        }
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            scheduleInactivityBlank()
        }
        if (isNavigationKey(event.keyCode)) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                handleNavigationKey(event.keyCode)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun isSelectKey(keyCode: Int): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_BUTTON_A -> true
            else -> false
        }
    }

    private fun isNavigationKey(keyCode: Int): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_BUTTON_A,
            KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_BACK,
            KeyEvent.KEYCODE_ESCAPE,
            KeyEvent.KEYCODE_BUTTON_B -> true
            else -> false
        }
    }

    private fun handleNavigationKey(keyCode: Int): Boolean {
        directionFromNavigationKey(keyCode)?.let { direction ->
            if (recordManualBlankSwipe(direction, SystemClock.elapsedRealtime())) {
                return true
            }
        } ?: resetManualBlankGestureTracker()
        return when (keyCode) {
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_BUTTON_A -> dispatchHudAction(HudAction.SELECT)
            KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_RIGHT -> dispatchHudAction(HudAction.NEXT)
            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_LEFT -> dispatchHudAction(HudAction.PREVIOUS)
            KeyEvent.KEYCODE_BACK,
            KeyEvent.KEYCODE_ESCAPE,
            KeyEvent.KEYCODE_BUTTON_B -> {
                if (!viewModel.handleBack()) finish()
                true
            }
            else -> false
        }
    }

    private fun directionFromNavigationKey(keyCode: Int): HorizontalSwipeDirection? =
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_RIGHT -> HorizontalSwipeDirection.FORWARD
            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_LEFT -> HorizontalSwipeDirection.BACKWARD
            else -> null
        }

    private fun directionFromDx(dx: Float): HorizontalSwipeDirection =
        if (dx > 0f) HorizontalSwipeDirection.FORWARD else HorizontalSwipeDirection.BACKWARD

    private fun recordManualBlankSwipe(direction: HorizontalSwipeDirection, atMs: Long): Boolean {
        if (!manualBlankGestureTracker.record(direction, atMs)) return false
        blankDisplay()
        return true
    }

    private fun resetManualBlankGestureTracker() {
        manualBlankGestureTracker.reset()
    }

    private fun dispatchHudAction(action: HudAction): Boolean {
        if (action == HudAction.SELECT) {
            resetManualBlankGestureTracker()
            val now = SystemClock.elapsedRealtime()
            if (now - lastSelectActionAtMs < SelectActionDebounceMs) {
                return true
            }
            lastSelectActionAtMs = now
        }
        if (action == HudAction.NEXT || action == HudAction.PREVIOUS) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastDirectionalActionAtMs < DirectionalActionDebounceMs) {
                return true
            }
            lastDirectionalActionAtMs = now
        }
        return viewModel.handleAction(action)
    }

    private fun requestRuntimePermissions() {
        permissionLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
    }

    private fun blankDisplay() {
        if (displayBlanked) return
        manualBlankGestureTracker.reset()
        inactivityHandler.removeCallbacks(inactivityBlankRunnable)
        val attributes = window.attributes
        previousScreenBrightness = attributes.screenBrightness
        attributes.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_OFF
        window.attributes = attributes
        displayBlanked = true
        viewModel.setDisplayBlanked(true)
    }

    private fun restoreDisplayIfBlanked() {
        if (!displayBlanked && previousScreenBrightness == null) return
        val attributes = window.attributes
        attributes.screenBrightness =
            previousScreenBrightness ?: WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = attributes
        previousScreenBrightness = null
        displayBlanked = false
        viewModel.setDisplayBlanked(false)
        manualBlankGestureTracker.reset()
        hideSystemBars()
    }

    private fun scheduleInactivityBlank() {
        inactivityHandler.removeCallbacks(inactivityBlankRunnable)
        if (displayBlanked || shouldPauseAutoBlanking(viewModel.state.value)) return
        inactivityHandler.postDelayed(inactivityBlankRunnable, DisplayInactivityTimeoutMs)
    }

    private fun observeDisplayActivity() {
        lifecycleScope.launch {
            viewModel.state.collect { state ->
                val snapshot = displayActivitySnapshot(state)
                if (snapshot == lastDisplayActivitySnapshot) return@collect
                lastDisplayActivitySnapshot = snapshot
                if (displayBlanked) return@collect
                scheduleInactivityBlank()
            }
        }
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireConversationWakeLock() {
        if (conversationWakeLock?.isHeld == true) return
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        conversationWakeLock = powerManager
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RokidConductor:conversation")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
    }

    private fun releaseConversationWakeLock() {
        conversationWakeLock?.let { wakeLock ->
            if (wakeLock.isHeld) wakeLock.release()
        }
        conversationWakeLock = null
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    companion object {
        private const val DirectionalActionDebounceMs = 360L
        private const val SelectActionDebounceMs = 450L
        private const val TouchpadScrollScale = 1.4f
        private const val DisplayInactivityTimeoutMs = 20_000L
    }
}
