import fs from "node:fs";

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function shellBasename(shell) {
  return String(shell || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/\.exe$/i, "");
}

function isShellPathLike(shell) {
  const value = String(shell || "");
  return /^[a-zA-Z]:[\\/]/.test(value) || value.includes("/") || value.includes("\\");
}

function isUsableWindowsEnvShell(shell, existsSync = fs.existsSync) {
  const normalized = normalizeOptionalString(shell);
  if (!normalized) {
    return false;
  }
  if (!isShellPathLike(normalized)) {
    return true;
  }
  try {
    return existsSync(normalized);
  } catch {
    return false;
  }
}

function isPowerShellShell(shell) {
  const name = shellBasename(shell);
  return name === "powershell" || name === "pwsh";
}

function isPosixLikeShell(shell) {
  const name = shellBasename(shell);
  return name === "bash" || name === "sh" || name === "zsh" || name === "dash" || name === "ksh";
}

export function resolveDefaultPtyShell({
  explicitShell,
  envShell = process.env.SHELL,
  comspec = process.env.COMSPEC,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const normalizedExplicitShell = normalizeOptionalString(explicitShell);
  if (normalizedExplicitShell) {
    return normalizedExplicitShell;
  }

  const normalizedEnvShell = normalizeOptionalString(envShell);
  if (platform === "win32") {
    if (isUsableWindowsEnvShell(normalizedEnvShell, existsSync)) {
      return normalizedEnvShell;
    }
    return normalizeOptionalString(comspec) || "cmd.exe";
  }

  if (normalizedEnvShell) {
    return normalizedEnvShell;
  }

  if (platform === "darwin") {
    return "/bin/zsh";
  }

  if (existsSync("/bin/bash")) {
    return "/bin/bash";
  }

  if (existsSync("/bin/sh")) {
    return "/bin/sh";
  }

  return "/bin/bash";
}

export function resolvePtyShellCommandArgs({
  shell,
  command,
  platform = process.platform,
} = {}) {
  const commandString = String(command ?? "");
  if (platform !== "win32" || isPosixLikeShell(shell)) {
    return ["-lc", commandString];
  }
  if (isPowerShellShell(shell)) {
    return ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandString];
  }
  return ["/d", "/s", "/c", commandString];
}

export function resolvePtyInteractiveShellArgs({
  shell,
  platform = process.platform,
} = {}) {
  if (platform !== "win32" || isPosixLikeShell(shell)) {
    return ["-l"];
  }
  if (isPowerShellShell(shell)) {
    return ["-NoLogo"];
  }
  return [];
}
