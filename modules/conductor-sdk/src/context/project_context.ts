import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface GuessResult {
  projectRoot: string;
  repoRoot?: string;
}

export interface WorkspaceSnapshot {
  projectRoot: string;
  repoRoot?: string;
  worktreeBranch?: string;
  lastCommit?: string;
  lastCommitAt?: string;
  /**
   * Normalized origin remote URL (lower-cased, trailing `.git` stripped).
   * Only populated when the workspace is a git repository AND has an
   * `origin` remote configured. Used by the web UI to merge same-name
   * projects across daemons that point to the same upstream repo.
   */
  gitRemoteUrl?: string;
  fileCount?: number;
}

export class ProjectContext {
  private readonly root: string;

  constructor(targetPath?: string) {
    const resolvedPath = path.resolve(targetPath ?? process.cwd());
    this.root = fs.realpathSync(resolvedPath);
  }

  guess(): GuessResult {
    const repoRoot = this.gitRoot(this.root);
    return {
      projectRoot: this.root,
      repoRoot: repoRoot ?? undefined,
    };
  }

  snapshot(): WorkspaceSnapshot {
    const guess = this.guess();
    if (!guess.repoRoot) {
      return {
        projectRoot: guess.projectRoot,
      };
    }
    return {
      projectRoot: guess.projectRoot,
      repoRoot: guess.repoRoot,
      worktreeBranch: this.gitBranch(guess.repoRoot) ?? undefined,
      lastCommit: this.gitHead(guess.repoRoot) ?? undefined,
      lastCommitAt: this.gitHeadCommittedAt(guess.repoRoot) ?? undefined,
      gitRemoteUrl: this.gitRemoteUrl(guess.repoRoot) ?? undefined,
      fileCount: this.gitFileCount(guess.repoRoot) ?? undefined,
    };
  }

  listFiles(relativeToRepo = true): string[] {
    const guess = this.guess();
    if (guess.repoRoot) {
      const files = this.gitListFiles(guess.repoRoot);
      if (relativeToRepo) {
        return files;
      }
      return files.map((file) => path.join(guess.repoRoot!, file));
    }
    const result: string[] = [];
    for (const filePath of walkFiles(guess.projectRoot)) {
      result.push(relativeToRepo ? path.relative(guess.projectRoot, filePath) : filePath);
    }
    return result.sort();
  }

  readFile(relativePath: string): string {
    const guess = this.guess();
    const base = guess.repoRoot ?? guess.projectRoot;
    const target = path.resolve(base, relativePath);
    return fs.readFileSync(target, 'utf-8');
  }

  getDiff(staged = false): string {
    const guess = this.guess();
    if (!guess.repoRoot) {
      return '';
    }
    const args = ['diff'];
    if (staged) {
      args.push('--staged');
    }
    return runGit(args, guess.repoRoot);
  }

  private gitRoot(start: string): string | null {
    try {
      const repoPath = runGit(['rev-parse', '--show-toplevel'], start).trim();
      return fs.realpathSync(repoPath);
    } catch {
      return null;
    }
  }

  private gitBranch(repoRoot: string): string | null {
    try {
      const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim();
      if (!branch || branch === 'HEAD') {
        return null;
      }
      return branch;
    } catch {
      return null;
    }
  }

  private gitHead(repoRoot: string): string | null {
    try {
      const head = runGit(['rev-parse', 'HEAD'], repoRoot).trim();
      return head || null;
    } catch {
      return null;
    }
  }

  private gitHeadCommittedAt(repoRoot: string): string | null {
    try {
      const committedAt = runGit(['show', '-s', '--format=%cI', 'HEAD'], repoRoot).trim();
      return committedAt || null;
    } catch {
      return null;
    }
  }

  private gitRemoteUrl(repoRoot: string): string | null {
    try {
      const url = runGit(['config', '--get', 'remote.origin.url'], repoRoot).trim();
      return normalizeGitRemoteUrl(url);
    } catch {
      return null;
    }
  }

  private gitFileCount(repoRoot: string): number | null {
    try {
      return this.gitListFiles(repoRoot).length;
    } catch {
      return null;
    }
  }

  private gitListFiles(repoRoot: string): string[] {
    try {
      const output = runGit(['ls-files'], repoRoot);
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'git command failed');
  }
  return result.stdout;
}

/**
 * Normalize a git remote URL so that variations of the same upstream
 * compare equal. Examples:
 *   git@github.com:foo/bar.git              -> github.com/foo/bar
 *   https://github.com/foo/bar/             -> github.com/foo/bar
 *   ssh://git@github.com/foo/bar            -> github.com/foo/bar
 *   https://gitea.local:3000/foo/bar.git    -> gitea.local:3000/foo/bar
 *   https://user:pass@gitlab.com/foo/bar    -> gitlab.com/foo/bar
 *
 * Two normalization paths:
 *  1. URL form (anything with `://`): parsed via WHATWG URL so host, port,
 *     and path are preserved correctly while user-info is dropped.
 *  2. scp form (`user@host:path`): handled with a small regex; the colon
 *     after host becomes a `/` so it lines up with the URL form. IPv6 hosts
 *     should use the `ssh://` URL form; git's scp-like syntax does not
 *     reliably represent bracketed IPv6 hosts.
 */
export function normalizeGitRemoteUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // URL form: ssh://, https://, http://, git://, ftp://, file://, etc.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    // `host` keeps the explicit port when present (e.g. `gitea.local:3000`).
    // `pathname` preserves the leading slash so `${host}${pathname}` reads
    // naturally; we drop trailing `/` and trailing `.git` afterwards.
    const path = parsed.pathname.replace(/\/+$/, '');
    const combined = `${canonicalGitRemoteHost(parsed.host)}${path}`.replace(/\.git$/i, '');
    return combined.toLowerCase() || null;
  }

  // scp form: `[user@]host:path`. The host segment must not contain `/`
  // (otherwise the first `/` would have shown up before the `:` and we'd
  // be looking at a relative-path URL, which git doesn't support as a
  // remote URL anyway).
  const scpMatch = trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(?!\/)(.*)$/);
  if (scpMatch) {
    const host = canonicalGitRemoteHost(scpMatch[1]);
    const path = scpMatch[2].replace(/\/+$/, '').replace(/\.git$/i, '');
    return `${host}/${path}`.toLowerCase() || null;
  }

  // Anything else (e.g. plain path) — give up so we don't fabricate a
  // misleading "normalized" form that could accidentally collide with a
  // real upstream URL.
  return null;
}

function canonicalGitRemoteHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  // SSH config alias used for GitHub remotes in our deployments.
  if (normalized === 'github-duinodu') {
    return 'github.com';
  }
  return normalized;
}

function* walkFiles(root: string): Generator<string> {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}
