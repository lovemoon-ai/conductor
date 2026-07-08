echo "/goal 开发一个 Rokid Glasses 原生 Android Conductor 客户端。

# Inputs（路径 / repo / 版本）
1. conductor: /Users/duino/ws/conductor
2. GlassKit reference: https://github.com/RealComputer/GlassKit
3. local references: ./rokid-reference.md

# Requirements
1. APK 直接安装到 Rokid Glasses，不通过手机端 CXR-M companion app。
2. 使用 Conductor device auth 登录。
3. 支持 project 选择、task 选择、进入 task。
4. 进入 task 后可以用眼镜麦克风发消息，并通过 Conductor WebSocket 接收 AI 回复。
5. 使用 Rokid 触摸板手势交互：轻触选择/语音，双击返回，前后滑动切换。

# Done（可自动验证）
android app 可构建；在设备或模拟器上可启动；登录、项目、任务、对话路径可在真实 Rokid Glasses 上完成硬件验证。
"
