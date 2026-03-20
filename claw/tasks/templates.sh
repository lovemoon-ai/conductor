function repeat_done() {
    echo "
Do not stop until the done condition is satisfied.
Do not stop until the done condition is satisfied.
Do not stop until the done condition is satisfied.
"
}

function new_feature() {
    echo "
# Goal (one sentence)
Implement \"$1\"

# Inputs (path / repo / version)
1. Start the local server: cd web && unset http_proxy && unset_https_proxy && unset_all_proxy && npm install && npm run dev
2. Local test method: open http://localhost:6152/ with chrome-devtools mcp and log in using env:CONDUCTOR_PHONE
3. Start the local conductor-daemon: conductor-daemon --config-file ~/.conductor/config-dev.yaml

# Non-goals (what not to do)

# Steps (must provide a plan first)
1. Use codemap to understand the current code, and only inspect code related to the task. For example, if the issue is in web, only read the web code; if it is in cli, only read the cli code. Do not scan the entire repo first.
2. Based on the feature description, propose an implementation plan, including the list of files to modify or add.
3. If the change touches backend APIs, add the corresponding unit tests and make them pass.
4. Test locally and make sure the feature behaves as expected. If it does not, analyze the issue, locate the problem, and fix it.

# Rules
1. If the feature is unrelated to web, for example a cli-only feature, you do not need to start the server or use chrome-devtools for testing.
2. When testing locally, turn off all proxies first: unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy

# Done (auto-verifiable)
Local testing completed for the \"$1\" feature

$(repeat_done)
"
}

function fix_bug() {
    echo "
# Goal (one sentence)
Bug symptom: \"$1\". Fix it.

# Inputs (path / repo / version)
1. Start the local server: cd web && unset http_proxy && unset_https_proxy && unset_all_proxy && npm install && npm run dev
2. Local test method: open http://localhost:6152/ with chrome-devtools mcp and log in using env:CONDUCTOR_PHONE
3. Start the local conductor daemon connected to the local server: conductor daemon --config-file ~/.conductor/config_local.yaml
4. Volcengine production deployment:
    a. Run `make info-volc` to inspect the Volcengine setup
    b. On the Volcengine machine: cd /opt/conductor/conductor && bash scripts/deploy-prod.sh
    c. If the local code changed, commit and push first, then pull on the Volcengine machine
5. Volcengine production test method: open https://conductor-ai.top/ with chrome-devtools mcp and log in using env:CONDUCTOR_PHONE
6. Start the conductor daemon connected to Volcengine production: conductor daemon --config-file ~/.conductor/config.yaml

# Steps (must provide a plan first)
1. Use codemap to understand the current code, and only inspect code related to the bug. For example, if the issue is in web, only read the web code; if it is in cli, only read the cli code. Do not scan the entire repo first.
2. Based on the bug type, determine whether it is a local server bug or a Volcengine production bug, then reproduce it using the appropriate environment.
3. Analyze the problem, list the files that need to change, and fix the bug.
4. Repeat steps 2-3-4 until it works.

# Notes
1. If chrome-devtools has trouble opening, kill the processes that are holding port 6152 and run `pkill chrome-devtools-mcp`.

# Done (auto-verifiable)
Bug eliminated

$(repeat_done)
"
}
