import { describe, expect, it, vi } from 'vitest';
import { backfillIssueAiSessionIfNeeded } from './backfill-ai-session';

const buildClient = () => ({
  $executeRawUnsafe: vi.fn(),
});

describe('backfillIssueAiSessionIfNeeded', () => {
  it('runs both UPDATEs and reports the row counts when the schema is current', async () => {
    const client = buildClient();
    client.$executeRawUnsafe
      .mockResolvedValueOnce(3) // backend backfill
      .mockResolvedValueOnce(2); // session backfill

    const result = await backfillIssueAiSessionIfNeeded(client);

    expect(client.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    const [backendSql] = client.$executeRawUnsafe.mock.calls[0];
    const [sessionSql] = client.$executeRawUnsafe.mock.calls[1];
    expect(backendSql).toContain('ai_backend_type');
    expect(backendSql).toContain('FROM "tasks" t');
    expect(sessionSql).toContain('ai_session_id');

    expect(result).toEqual({
      attempted: true,
      backendUpdated: 3,
      sessionUpdated: 2,
    });
  });

  it('reports zero updated rows on subsequent boots (idempotent)', async () => {
    const client = buildClient();
    client.$executeRawUnsafe.mockResolvedValue(0);

    const result = await backfillIssueAiSessionIfNeeded(client);

    expect(result).toEqual({
      attempted: true,
      backendUpdated: 0,
      sessionUpdated: 0,
    });
  });

  it('skips and warns when the ai_session columns are missing (db-push not yet run)', async () => {
    const client = buildClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.$executeRawUnsafe.mockRejectedValueOnce(
      new Error('SqliteError: no such column: ai_backend_type'),
    );

    const result = await backfillIssueAiSessionIfNeeded(client);

    expect(result).toEqual({
      attempted: true,
      backendUpdated: 0,
      sessionUpdated: 0,
      skippedReason: 'schema-missing',
    });
    // Second update is never attempted when the first signals schema mismatch.
    expect(client.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('skips quietly when the issues table itself does not exist (fresh install)', async () => {
    const client = buildClient();
    client.$executeRawUnsafe.mockRejectedValueOnce(
      new Error('SqliteError: no such table: issues'),
    );

    const result = await backfillIssueAiSessionIfNeeded(client);

    expect(result.skippedReason).toBe('table-missing');
    expect(result.backendUpdated).toBe(0);
    expect(result.sessionUpdated).toBe(0);
  });

  it('logs and resolves on unexpected errors instead of throwing', async () => {
    const client = buildClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.$executeRawUnsafe.mockRejectedValueOnce(new Error('connection lost'));

    const result = await backfillIssueAiSessionIfNeeded(client);

    expect(result.skippedReason).toBe('error');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still records the backend backfill even if the session UPDATE fails afterwards', async () => {
    const client = buildClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.$executeRawUnsafe
      .mockResolvedValueOnce(5) // backend succeeds
      .mockRejectedValueOnce(new Error('connection lost')); // session fails

    const result = await backfillIssueAiSessionIfNeeded(client);

    expect(result.backendUpdated).toBe(5);
    expect(result.sessionUpdated).toBe(0);
    expect(result.skippedReason).toBe('error');
    warnSpy.mockRestore();
  });
});
