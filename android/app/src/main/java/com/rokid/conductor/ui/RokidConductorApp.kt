package com.rokid.conductor.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.rokid.conductor.AppViewModel
import com.rokid.conductor.Screen
import com.rokid.conductor.net.ChatMessage

@Composable
fun RokidConductorApp(vm: AppViewModel) {
    val state by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(state.error, state.info) {
        val msg = state.error ?: state.info
        if (!msg.isNullOrBlank()) {
            snackbar.showSnackbar(msg)
            vm.clearMessages()
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (state.screen) {
                Screen.LOGIN -> LoginScreen(vm, state)
                Screen.PROJECTS -> ProjectsScreen(vm, state)
                Screen.TASKS -> TasksScreen(vm, state)
                Screen.CHAT -> ChatScreen(vm, state)
            }
            if (state.loading) {
                Box(
                    Modifier.fillMaxSize().background(Color(0x22000000)),
                    contentAlignment = Alignment.Center
                ) { CircularProgressIndicator() }
            }
        }
    }
}

@Composable
private fun LoginScreen(vm: AppViewModel, state: com.rokid.conductor.UiState) {
    var code by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Spacer(Modifier.height(32.dp))
        Text("Rokid Conductor", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("登录后选择项目与任务，在眼镜上与 AI 对话", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = state.baseUrl, onValueChange = vm::setBaseUrl,
            label = { Text("服务器地址") }, singleLine = true, modifier = Modifier.fillMaxWidth()
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.countryCode, onValueChange = vm::setCountryCode,
                label = { Text("区号") }, singleLine = true, modifier = Modifier.width(96.dp)
            )
            OutlinedTextField(
                value = state.phone, onValueChange = vm::setPhone,
                label = { Text("手机号") }, singleLine = true, modifier = Modifier.weight(1f)
            )
        }
        Button(onClick = vm::requestCode, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.codeSent) "重新发送验证码" else "发送验证码")
        }
        if (state.codeSent) {
            OutlinedTextField(
                value = code, onValueChange = { code = it },
                label = { Text("验证码") }, singleLine = true, modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { vm.verifyCode(code) }, enabled = !state.loading,
                modifier = Modifier.fillMaxWidth()
            ) { Text("登录 / 注册") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProjectsScreen(vm: AppViewModel, state: com.rokid.conductor.UiState) {
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("项目") },
            actions = {
                GlassesChip(vm, state)
                TextButton(onClick = vm::logout) { Text("退出") }
            }
        )
        if (state.projects.isEmpty() && !state.loading) {
            EmptyHint("暂无项目，下拉刷新或在 Conductor 网页端创建") { vm.loadProjects() }
        }
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
            items(state.projects, key = { it.id }) { p ->
                ListCard(title = p.name, subtitle = if (p.isDefault) "默认项目" else p.id) {
                    vm.selectProject(p)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TasksScreen(vm: AppViewModel, state: com.rokid.conductor.UiState) {
    var showCreate by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(state.selectedProject?.name ?: "任务", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = {
                IconButton(onClick = vm::goBack) { Icon(Icons.Default.ArrowBack, "返回") }
            },
            actions = {
                GlassesChip(vm, state)
                TextButton(onClick = { showCreate = true }) { Text("新建") }
            }
        )
        if (state.tasks.isEmpty() && !state.loading) {
            EmptyHint("暂无任务，点击右上角新建") { vm.loadTasks() }
        }
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
            items(state.tasks, key = { it.id }) { t ->
                ListCard(title = t.title, subtitle = "状态: ${t.status}") { vm.selectTask(t) }
            }
        }
    }
    if (showCreate) {
        CreateTaskDialog(
            onDismiss = { showCreate = false },
            onCreate = { title, initial -> showCreate = false; vm.createTask(title, initial) }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(vm: AppViewModel, state: com.rokid.conductor.UiState) {
    var input by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = {
                Column {
                    Text(
                        state.selectedTask?.title ?: "对话",
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(
                        if (state.realtimeConnected) "实时已连接" else "实时连接中…",
                        style = MaterialTheme.typography.labelSmall
                    )
                }
            },
            navigationIcon = {
                IconButton(onClick = vm::goBack) { Icon(Icons.Default.ArrowBack, "返回") }
            },
            actions = { GlassesChip(vm, state) }
        )

        val listState = androidx.compose.foundation.lazy.rememberLazyListState()
        LaunchedEffect(state.messages.size) {
            if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.size - 1)
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(state.messages, key = { it.id.ifBlank { it.hashCode().toString() } }) { m ->
                MessageBubble(m)
            }
            if (state.awaitingReply) {
                item { Text("AI 正在思考…", Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall) }
            }
        }

        if (state.sttListening) {
            Text(
                "聆听中: ${state.sttPartial}",
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                style = MaterialTheme.typography.bodySmall
            )
        }

        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = input, onValueChange = { input = it },
                modifier = Modifier.weight(1f), placeholder = { Text("输入消息…") }, maxLines = 4
            )
            // Push-to-talk mic button (phone mic; routed through glasses when connected).
            Box(
                Modifier.size(48.dp).background(
                    if (state.sttListening) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.secondaryContainer,
                    CircleShape
                ).pointerInput(Unit) {
                    detectTapGestures(onPress = {
                        vm.startVoice()
                        tryAwaitRelease()
                        vm.stopVoice()
                    })
                },
                contentAlignment = Alignment.Center
            ) { Icon(Icons.Default.Mic, "按住说话") }
            IconButton(
                onClick = { vm.sendText(input); input = "" },
                enabled = input.isNotBlank()
            ) { Icon(Icons.Default.Send, "发送") }
        }
    }
}

@Composable
private fun MessageBubble(m: ChatMessage) {
    val isUser = m.role == "user"
    val bg = if (isUser) MaterialTheme.colorScheme.primaryContainer
    else MaterialTheme.colorScheme.surfaceVariant
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
        Surface(color = bg, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(0.85f)) {
            Column(Modifier.padding(10.dp)) {
                Text(
                    roleLabel(m.role),
                    style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold
                )
                Text(m.content.ifBlank { "(空)" }, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

private fun roleLabel(role: String) = when (role) {
    "user" -> "我"
    "assistant", "sdk" -> "AI"
    "system" -> "系统"
    else -> role
}

@Composable
private fun ListCard(title: String, subtitle: String, onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp).clickable(onClick = onClick)
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun EmptyHint(text: String, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(text, style = MaterialTheme.typography.bodyMedium)
        OutlinedButton(onClick = onRetry) { Text("刷新") }
    }
}

@Composable
private fun GlassesChip(vm: AppViewModel, state: com.rokid.conductor.UiState) {
    var show by remember { mutableStateOf(false) }
    val dot = if (state.glassesConnected) Color(0xFF2E7D32) else Color(0xFFC62828)
    Row(
        Modifier.clickable { vm.refreshGlassDevices(); show = true }.padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(10.dp).background(dot, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text("眼镜", style = MaterialTheme.typography.labelMedium)
    }
    if (show) {
        GlassesDialog(vm, state, onDismiss = { show = false })
    }
}

@Composable
private fun GlassesDialog(vm: AppViewModel, state: com.rokid.conductor.UiState, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("连接眼镜") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(state.glassesStatus, style = MaterialTheme.typography.bodyMedium)
                if (state.glassesDevices.isEmpty()) {
                    Text("未发现已配对设备。请先在系统蓝牙设置中配对 Rokid 眼镜。",
                        style = MaterialTheme.typography.bodySmall)
                }
                state.glassesDevices.forEach { d ->
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth().clickable {
                            vm.connectGlasses(d.mac); onDismiss()
                        }
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Text(d.name, fontWeight = FontWeight.SemiBold)
                            Text(d.mac, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { vm.refreshGlassDevices() }) { Text("刷新设备") }
        },
        dismissButton = {
            Row {
                if (state.glassesConnected) {
                    TextButton(onClick = { vm.disconnectGlasses(); onDismiss() }) { Text("断开") }
                }
                TextButton(onClick = onDismiss) { Text("关闭") }
            }
        }
    )
}

@Composable
private fun CreateTaskDialog(onDismiss: () -> Unit, onCreate: (String, String?) -> Unit) {
    var title by remember { mutableStateOf("") }
    var initial by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建任务") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = title, onValueChange = { title = it },
                    label = { Text("任务标题") }, singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = initial, onValueChange = { initial = it },
                    label = { Text("首条消息（可选）") }, modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(title, initial.ifBlank { null }) },
                enabled = title.isNotBlank()
            ) { Text("创建") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}
