import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { ProjectContext } from '../src/context/index.js';
function gitEnv() {
    return {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
    };
}
function initRepo(repoPath) {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoPath, env: gitEnv(), stdio: 'ignore' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Demo\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: gitEnv(), stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, env: gitEnv(), stdio: 'ignore' });
}
describe('ProjectContext', () => {
    test('guess returns repo root', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-'));
        initRepo(dir);
        const ctx = new ProjectContext(dir);
        const result = ctx.guess();
        const realPath = fs.realpathSync(dir);
        expect(result.repoRoot).toBe(realPath);
        expect(result.projectRoot).toBe(realPath);
    });
    test('listFiles matches git listing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-'));
        initRepo(dir);
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'main.py'), 'print("hi")\n');
        execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv(), stdio: 'ignore' });
        const ctx = new ProjectContext(dir);
        const files = ctx.listFiles();
        expect(files).toContain('README.md');
        expect(files).toContain(path.join('src', 'main.py'));
    });
    test('getDiff returns git diff output', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-'));
        initRepo(dir);
        const file = path.join(dir, 'README.md');
        fs.writeFileSync(file, '# Demo!\n');
        const ctx = new ProjectContext(dir);
        const diff = ctx.getDiff();
        expect(diff).toContain('Demo');
    });
});
