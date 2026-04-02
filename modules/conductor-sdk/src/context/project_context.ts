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
