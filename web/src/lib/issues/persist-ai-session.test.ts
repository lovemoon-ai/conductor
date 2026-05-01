import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { persistIssueAiSession } from './persist-ai-session';

const buildWriter = () => ({
  issue: {
    update: vi.fn().mockResolvedValue({}),
  },
});

describe('persistIssueAiSession', () => {
  it('writes both fields when both are non-empty', async () => {
    const writer = buildWriter();

    await persistIssueAiSession(writer, 'issue-1', {
      backendType: 'codex',
      sessionId: 'sess-abc',
    });

    expect(writer.issue.update).toHaveBeenCalledTimes(1);
    expect(writer.issue.update).toHaveBeenCalledWith({
      where: { id: 'issue-1' },
      data: {
        aiBackendType: 'codex',
        aiSessionId: 'sess-abc',
      },
    });
  });

  it('writes only the field that has a non-empty value', async () => {
    const writer = buildWriter();

    await persistIssueAiSession(writer, 'issue-1', {
      backendType: 'claude',
      sessionId: null,
    });

    expect(writer.issue.update).toHaveBeenCalledWith({
      where: { id: 'issue-1' },
      data: { aiBackendType: 'claude' },
    });
  });

  it('skips the write entirely when both inputs are empty (preservation policy)', async () => {
    const writer = buildWriter();

    await persistIssueAiSession(writer, 'issue-1', {
      backendType: null,
      sessionId: '   ',
    });

    expect(writer.issue.update).not.toHaveBeenCalled();
  });

  it('skips the write when issueId is missing', async () => {
    const writer = buildWriter();

    await persistIssueAiSession(writer, null, {
      backendType: 'codex',
      sessionId: 'sess-1',
    });
    await persistIssueAiSession(writer, undefined, {
      backendType: 'codex',
      sessionId: 'sess-1',
    });
    await persistIssueAiSession(writer, '   ', {
      backendType: 'codex',
      sessionId: 'sess-1',
    });

    expect(writer.issue.update).not.toHaveBeenCalled();
  });

  it('warns and swallows P2022 errors so AI task creation keeps working pre-migration', async () => {
    const writer = buildWriter();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writer.issue.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        'The column `issues.ai_session_id` does not exist in the current database.',
        { code: 'P2022', clientVersion: 'test' },
      ),
    );

    await expect(
      persistIssueAiSession(writer, 'issue-1', {
        backendType: 'codex',
        sessionId: 'sess-abc',
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('silently ignores deleted-issue (P2025) errors', async () => {
    const writer = buildWriter();
    writer.issue.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );

    await expect(
      persistIssueAiSession(writer, 'issue-1', {
        backendType: 'codex',
        sessionId: 'sess-abc',
      }),
    ).resolves.toBeUndefined();
  });

  it('rethrows unrelated Prisma errors so callers see real failures', async () => {
    const writer = buildWriter();
    writer.issue.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Constraint failed', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );

    await expect(
      persistIssueAiSession(writer, 'issue-1', {
        backendType: 'codex',
        sessionId: 'sess-abc',
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
