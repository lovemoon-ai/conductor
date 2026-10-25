import fs from "node:fs";

import { launchProviderBrowser } from "./browser.js";
import { brokerPaths } from "./broker-protocol.js";
import { getProvider } from "./provider.js";
import { clearProfileOwner } from "./profile-lock.js";
import { profileDir } from "./paths.js";
import { startTurnBroker } from "./turn-broker.js";
import { registerBuiltinProviders } from "../providers/index.js";
import type { SessionOpenOptions } from "../session.js";

const providerName = process.argv[2]!;
const options: SessionOpenOptions = JSON.parse(process.argv[3] ?? "{}");
const paths = brokerPaths(providerName);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The broker holds this startup lock until its socket/browser have closed. */
function acquire(): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(paths.lock, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { fs.closeSync(fd); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(paths.lock);
        const text = fs.readFileSync(paths.lock, "utf8");
        let pid: number;
        try { pid = JSON.parse(text).pid; } catch { pid = 0; }
        // Another process may have just created the file but not written it.
        if (!Number.isInteger(pid) || pid <= 0) {
          if (Date.now() - stat.mtimeMs < 30_000) return false;
        } else if (alive(pid)) return false;
        const current = fs.statSync(paths.lock);
        if (current.ino !== stat.ino || fs.readFileSync(paths.lock, "utf8") !== text) continue;
        fs.unlinkSync(paths.lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return false;
}

if (acquire()) {
  let ownsBrowser = false;
  try {
    if (process.platform !== "win32") fs.rmSync(paths.socket, { force: true });
    registerBuiltinProviders();
    const provider = getProvider(providerName);
    const broker = await startTurnBroker({
      socketPath: paths.socket,
      provider,
      launch: async () => {
        const launched = await launchProviderBrowser(providerName, { headless: options.headless, ...options.launch });
        ownsBrowser = true;
        return launched;
      },
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      const force = setTimeout(() => process.exit(1), 10_000);
      force.unref();
      void broker.close();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    await broker.closed;
  } finally {
    if (ownsBrowser) clearProfileOwner(profileDir(providerName));
    fs.rmSync(paths.lock, { force: true });
  }
}

// Detached broker workers own no useful work after shutdown. An adapter's
// abandoned SSE timer must not keep an empty worker alive for several minutes.
process.exit(0);
