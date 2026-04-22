# @love-moon/ai-manager

Manage local AI CLI tools (codex, claude, kimi, copilot) for conductor. Runs inside the
daemon process so it can read local credential files, query the Keychain, and
make outbound requests over the host's network/VPN.

## Features

- **Install status** — detect whether `codex`, `claude`, and `kimi` are on PATH, and whether the bundled Copilot SDK is available
- **Network reachability** — probe `chatgpt.com`, `api.anthropic.com`, `api.kimi.com`, `api.githubcopilot.com` (VPN sanity check)
- **Quota** — pull usage for all tools via authenticated probes against each provider's own rate-limit channel; results are cached on disk with a TTL
- **Codex account switching** — list configured `~/.codex/auth.json` profiles and atomically swap between them

## Config

Reads from `~/.conductor/config.yaml`:

```yaml
ai_manager:
  codex:
    auth_json:
      - /abs/path/auth_accountA.json
      - /abs/path/auth_accountB.json
```

The `codex.auth_json` list controls account switching. Quota and install
detection require nothing in the conductor config.

## How quota is fetched

Each provider exposes usage on a different surface. There is no stable local
command, so we hit the same channel the official CLI uses.

| Tool   | Source                                                               | Auth                                                                                                        |
| ------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| codex  | `POST chatgpt.com/backend-api/codex/responses` rate-limit headers    | `tokens.access_token` from `~/.codex/auth.json`; model resolved from `~/.codex/config.toml`                 |
| claude | `POST api.anthropic.com/v1/messages` rate-limit headers              | `ANTHROPIC_API_KEY` env, then macOS Keychain entry `Claude Code-credentials`, then `~/.claude/.credentials.json` |
| kimi   | `GET api.kimi.com/coding/v1/usages`                                  | `~/.kimi/credentials/kimi-code.json`; expired access tokens are refreshed automatically and persisted back   |
| copilot | `@github/copilot-sdk` RPC `account.getQuota`                        | SDK logged-in auth discovery: stored Copilot login or `gh` auth; explicit tokens are only used when passed through API options |

For codex the body stream is aborted as soon as headers arrive, so the probe
costs at most one token of quota. Quota responses are cached at
`~/.conductor/cache/ai-manager/quota-<tool>-<fp>.json` with a 60s TTL by
default; pass `forceRefresh: true` to bypass.

## API

```ts
import { AiManager } from "@love-moon/ai-manager";

const m = new AiManager();

// 1) install
await m.checkInstall("codex");
await m.checkInstallAll(); // { codex, claude, kimi, copilot }

// 2) network
await m.checkNetwork("kimi");
await m.checkNetworkAll();

// 3) quota
await m.getCodexQuota();
await m.getClaudeQuota();
await m.getKimiQuota();
await m.getCopilotQuota();
//   { fiveHour, weekly, source: 'fresh'|'cached'|'stale'|'unknown', ... }

// 4) codex accounts
await m.listCodexAccounts();          // [{ name, email, planType, isCurrent }, ...]
await m.getCurrentCodexAccount();
await m.switchCodexAccount("accountB"); // atomic rename + 0o600, backs up to auth.json.bak
```

Lower-level functions (`checkInstall`, `getKimiQuota`, `loadAiManagerConfig`,
`parseAuthFile`, …) are exported individually if you want to bypass the
aggregator.

## Identity / safety

- Codex account identity is `email|account_id` from the JWT, not a token
  prefix — OpenAI access tokens share a long header prefix and would otherwise
  collide.
- `switchCodexAccount` writes to `auth.json.tmp` and renames over
  `~/.codex/auth.json` so partial writes can never produce a corrupt file.
  The previous content is copied to `auth.json.bak` first.
- A switch does **not** affect codex processes that are already running; they
  hold the old token in memory until they restart.
- Quota probes never log raw bearer tokens.

## Testing

```
pnpm install
pnpm test       # node --test, ~14 unit tests
pnpm typecheck
pnpm build
```
