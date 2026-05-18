/**
 * Connect + option validation smoke tests. Larger behavioral coverage lives
 * in test/server/{fetcher,projects,tasks,subscribe}.test.ts and
 * test/contract/.
 */
import { describe, it, expect } from 'vitest';
import { connect, AppClient } from '../../src/server/index.js';
import { ConductorAppError, SDK_VERSION } from '../../src/index.js';

describe('connect()', () => {
  it('exports SDK_VERSION', () => {
    expect(typeof SDK_VERSION).toBe('string');
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns an AppClient instance', async () => {
    const client = await connect({
      baseUrl: 'http://localhost:6152',
      bearerToken: 'fake-token',
    });
    expect(client).toBeInstanceOf(AppClient);
    expect(client.projects).toBeDefined();
    expect(client.tasks).toBeDefined();
    await client.close();
  });

  it('rejects empty baseUrl', async () => {
    await expect(
      connect({ baseUrl: '', bearerToken: 'x' }),
    ).rejects.toBeInstanceOf(ConductorAppError);
  });

  it('rejects empty bearerToken', async () => {
    await expect(
      connect({ baseUrl: 'http://x', bearerToken: '' }),
    ).rejects.toBeInstanceOf(ConductorAppError);
  });
});
