# stable: Daemon VPN/NAT Zombie WebSocket + Trailing Slash Probe Bug

**Date**: 2026-06-10  
**Severity**: High — M1 daemon kept crashing and restarting in a loop for ~3 hours tonight

---

## Symptom

The M1 daemon kept disconnecting and reconnecting repeatedly throughout the evening. Production logs showed 96 `Agent connected: agentHost=m1` entries (normally should be a handful per day). Nginx logs showed 6,372 double-slash HTTP redirects (`//api/agents`, `//api/tasks`) from M1's VPN subnet.

Connection sizes in nginx progressed through stages of severity:
- ~210 bytes: partial connection (auth succeeded, some data, then disconnect)
- ~304 bytes: slightly more data  
- **6 bytes**: immediate close frame — worst state (23:22–23:34)

Fire agents from M1 still worked fine (8+ KB connections completing tasks).

---

## Root Causes

### 1. VPN/NAT Silent TCP Drop — Zombie WebSocket Connections

The M1 Mac's VPN/NAT was silently dropping TCP connections without sending a FIN or RST. The WebSocket SDK on the daemon side still believed it was connected (`wsConnected = true`), but no pings could traverse the dead TCP connection.

The sequence:
1. VPN drops TCP silently → no close frame → SDK still thinks connected
2. Server sends ping every 25s, gets no pong → `socket.terminate()` after ~50s
3. Watchdog fires every 30s. After 75s of no pong/inbound, detects stale WS
4. Watchdog calls `requestWatchdogSelfHeal` → `watchdogHealAttempts += 1`
5. Forces reconnect via `client.forceReconnect()`
6. If VPN drops again before a pong arrives (20s heartbeat), heal counter stays elevated
7. After 4 self-heals (>`DAEMON_WATCHDOG_MAX_SELF_HEALS=3`), daemon exits
8. Supervisor (launchd) restarts the daemon → repeat

The default `DAEMON_WATCHDOG_MAX_SELF_HEALS=3` was too low for a flaky VPN environment.

### 2. Trailing Slash in `backend_url` Config → Double HTTP Requests

The M1's `~/.conductor/config.yaml` had `backend_url: "https://conductor-ai.top/"` (trailing slash). The daemon code at line 686–691 used `fileConfig?.backendUrl` directly without normalizing. This caused:

```
BACKEND_HTTP = "https://conductor-ai.top/"
probe URL = "https://conductor-ai.top/" + "/api/agents"
         = "https://conductor-ai.top//api/agents"
```

Nginx returns 308 (redirect) → daemon follows → 200. Every watchdog probe required TWO HTTP round trips instead of one. Not the root cause of tonight's crashes, but confirmed wasteful (6,372 extra requests).

---

## Fix

### daemon.js — Normalize `BACKEND_HTTP` trailing slash

```javascript
// Before
const BACKEND_HTTP =
  config.BACKEND_HTTP ||
  process.env.CONDUCTOR_BACKEND_URL ||
  derivedHttpFromWs ||
  fileConfig?.backendUrl ||
  "http://localhost:6152";

// After
const BACKEND_HTTP = (
  config.BACKEND_HTTP ||
  process.env.CONDUCTOR_BACKEND_URL ||
  derivedHttpFromWs ||
  fileConfig?.backendUrl ||
  "http://localhost:6152"
).replace(/\/+$/, "");
```

### daemon.js — Increase `DAEMON_WATCHDOG_MAX_SELF_HEALS` default from 3 → 6

```javascript
// Before
const DAEMON_WATCHDOG_MAX_SELF_HEALS = parsePositiveInt(
  process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS,
  3,
);

// After
const DAEMON_WATCHDOG_MAX_SELF_HEALS = parsePositiveInt(
  process.env.CONDUCTOR_DAEMON_WATCHDOG_MAX_SELF_HEALS,
  6,
);
```

---

## How to Diagnose Next Time

1. Check nginx for double-slash patterns: `grep '//api' /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head`
2. Count m1 WebSocket connections: `grep 'agentHost=m1' /opt/conductor/conductor.log | wc -l`
3. Look at WS connection byte sizes in nginx log to judge severity:
   - 1MB+: long-lived, healthy
   - 7–9KB: fire agent (normal short-lived)  
   - 200–300 bytes: auth succeeds but drops quickly (network instability)
   - 6 bytes: immediate close frame (severe rapid reconnect loop)
4. Check for watchdog self-heals: `grep -a 'self-heal\|watchdog' ~/.conductor/logs/conductor-daemon.log | tail -20`

## How to Avoid

- Always normalize `BACKEND_HTTP` when it comes from external config — trailing slash is an easy mistake in config files
- Set a generous `DAEMON_WATCHDOG_MAX_SELF_HEALS` default. The daemon exiting forces a full supervisor restart + new process startup, which is more disruptive than a few extra reconnect attempts
- The real long-term fix is per-user VPN stability, but the daemon should survive flaky networks gracefully
