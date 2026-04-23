import { describe, expect, it } from 'vitest';
import { normalizeAgent } from './store';

describe('normalizeAgent', () => {
  it('reads camelCase fields', () => {
    const agent = normalizeAgent({
      id: 'agent-1',
      host: 'daemon-a',
      supportedBackends: ['codex', 'claude'],
      runtimeBackendMap: { codex: 'codex' },
      capabilities: ['pty_task'],
      version: '1.2.3',
    });
    expect(agent).toMatchObject({
      id: 'agent-1',
      host: 'daemon-a',
      supportedBackends: ['codex', 'claude'],
      runtimeBackendMap: { codex: 'codex' },
      capabilities: ['pty_task'],
      version: '1.2.3',
    });
  });

  it('falls back to snake_case fields', () => {
    const agent = normalizeAgent({
      id: 'agent-2',
      host: 'daemon-b',
      supported_backends: ['kimi'],
      runtime_backend_map: { kimi: 'kimi' },
    });
    expect(agent).toMatchObject({
      id: 'agent-2',
      host: 'daemon-b',
      supportedBackends: ['kimi'],
      runtimeBackendMap: { kimi: 'kimi' },
    });
  });

  it('returns null for invalid input', () => {
    expect(normalizeAgent(null)).toBeNull();
    expect(normalizeAgent({ id: 'x' })).toBeNull();
    expect(normalizeAgent({ host: 'y' })).toBeNull();
  });
});
