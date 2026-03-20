# Goal

Implement "Support sending pictures and videos in Conductor Task (by injecting Task ID + Skill to return multimedia)"
## Inputs
1. Start the server locally: cd web && unset http_proxy && unset_https_proxy && unset_all_proxy && npm install && npm run dev
2. Local test method: Use chrome-devtools mcp to open http://localhost:6152/, use `env:CONDUCTOR_PHONE` to complete the login
3. Start conductor-daemon locally: conductor-daemon --config-file ~/.conductor/config-dev.yaml
## Non-goals
1. This issue does not provide large-scale media transcoding services.
2. Direct transmission of any very large files is not supported (limit the size and format first)
3. Do not implement the media content review strategy in this issue
## Steps
1. Codemap understands the current code and only looks at the message upload link, task message model, and tool/skill calling mechanism.
2. Design data flow:
   - Inject `CONDUCTOR_TASK_ID` when spawning AI tool
   - The skill reads the taskId and then calls the upload tool to send pictures/videos to the specified task.
3. Backend implementation:
   - Add media message type and storage path (object storage or local storage abstraction)
   - Add upload interface and authentication (task-level permission verification)
4. Front-end implementation:
   - The chat area supports media message rendering (picture preview, video player)
   - Failure retry and upload progress prompts
5. Test:
   - API single test coverage format, size, permission verification
   - The pictures/videos returned by the e2e manual verification skill are visible in the corresponding tasks.
## Rules
1. Force verification of MIME type and file size limit
2. When testing locally, turn off all proxies and then test: unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
3. The upload interface must be bound to taskId, and cross-task injection is prohibited.
## Implementation points
1. It is recommended to add `messageType=media` and `mediaMeta` fields to the message model
2. The environment variable injection point is placed at the unified entrance of the tool launcher
3. The integration of Skill and Conductor is based on the minimum protocol: `taskId + fileUrl + mediaType`
## Acceptance criteria
1. Pictures and videos can be successfully sent and displayed in the task
2. By injecting taskId into the skill return content, the content can accurately fall into the current task.
3. Illegal types, over-limit files, and unauthorized taskIds are all intercepted.
## Risks and rollback
1. Risks: Media storage costs and bandwidth growth
2. Rollback: You can press the switch to disable video uploading and keep only images or text.
## Done
Local testing to implement the function of "Support sending pictures and videos in Conductor Task (by injecting Task ID + Skill to return multimedia)"
Do not stop until the done condition is satisfied.