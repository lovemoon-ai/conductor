# @dang7up/ai-manager

Manage local AI CLI tools for conductor.

Features:

- Detect install status of `codex` and `claude` CLIs
- Probe VPN/network reachability for ChatGPT and Anthropic endpoints
- Fetch 5h / weekly quota usage for both tools (via authenticated header probes)
- List and switch Codex accounts (swap `~/.codex/auth.json` between configured profiles)

Config (from `~/.conductor/config.yaml`):

```yaml
ai_manager:
  codex:
    auth_json:
      - /abs/path/auth_accountA.json
      - /abs/path/auth_accountB.json
```

## API

```ts
import { AiManager } from "@dang7up/ai-manager";

const m = new AiManager();

await m.checkInstallAll();
await m.checkNetwork("codex");
await m.getCodexQuota();
await m.getClaudeQuota();

await m.listCodexAccounts();
await m.switchCodexAccount("accountB");
```
