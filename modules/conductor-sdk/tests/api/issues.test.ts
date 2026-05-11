import { describe, expect, test } from 'vitest';

import { IssuesApi } from '../../src/api/index.js';
import { BackendApiError } from '../../src/backend/index.js';

interface IssueRecord {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  status?: string;
  priority?: string;
  metadata?: Record<string, unknown> | null;
}

class FakeApiClient {
  issues: IssueRecord[] = [];
  createCalls: any[] = [];
  patchCalls: Array<{ id: string; body: any }> = [];
  deleteCalls: string[] = [];
  listCalls: any[] = [];

  async listIssues(params: any) {
    this.listCalls.push(params);
    let result = this.issues;
    if (params.projectId) {
      result = result.filter((issue) => issue.projectId === params.projectId);
    }
    if (params.status) {
      result = result.filter((issue) => issue.status === params.status);
    }
    return result.map((issue) => ({ ...issue }));
  }

  async getIssue(issueId: string) {
    const found = this.issues.find((issue) => issue.id === issueId);
    if (!found) {
      throw new BackendApiError('not found', 404, { error: 'Not found' });
    }
    return { ...found };
  }

  async createIssue(params: any) {
    this.createCalls.push(params);
    const issue: IssueRecord = {
      id: 'issue-new',
      projectId: params.projectId,
      title: params.title,
      description: params.description ?? null,
      status: params.status ?? 'todo',
      priority: params.priority ?? 'P2',
      metadata: params.metadata ?? null,
    };
    this.issues.push(issue);
    return { ...issue };
  }

  async patchIssue(issueId: string, body: any) {
    this.patchCalls.push({ id: issueId, body });
    const issue = this.issues.find((entry) => entry.id === issueId);
    if (!issue) {
      throw new BackendApiError('not found', 404, { error: 'Not found' });
    }
    if (body.title !== undefined) issue.title = body.title;
    if (body.description !== undefined) issue.description = body.description;
    if (body.status !== undefined) issue.status = body.status;
    if (body.priority !== undefined) issue.priority = body.priority;
    if (body.metadata !== undefined) {
      issue.metadata =
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : null;
    }
    // Mirror the real PATCH response shape, which wraps the issue.
    return { issue: { ...issue }, activeTask: null };
  }

  async deleteIssue(issueId: string) {
    this.deleteCalls.push(issueId);
    const idx = this.issues.findIndex((issue) => issue.id === issueId);
    if (idx === -1) {
      throw new BackendApiError('not found', 404, { error: 'Not found' });
    }
    this.issues.splice(idx, 1);
  }
}

const makeApi = (issues: IssueRecord[] = []) => {
  const client = new FakeApiClient();
  client.issues = issues.map((issue) => ({ ...issue }));
  const api = new IssuesApi(client as any, { sdkVersion: '0.0.0-test', env: {} });
  return { client, api };
};

describe('IssuesApi', () => {
  test('listIssues passes projectId/status to client and normalizes', async () => {
    const { client, api } = makeApi([
      { id: 'i1', projectId: 'p1', title: 'A', status: 'todo' },
      { id: 'i2', projectId: 'p1', title: 'B', status: 'doing' },
      { id: 'i3', projectId: 'p2', title: 'C', status: 'todo' },
    ]);
    const issues = await api.listIssues({ projectId: 'p1', status: 'doing' });
    expect(issues.map((issue) => issue.id)).toEqual(['i2']);
    expect(client.listCalls[0]).toMatchObject({ projectId: 'p1', status: 'doing' });
  });

  test('listIssues with multi-status filters client-side', async () => {
    const { client, api } = makeApi([
      { id: 'i1', projectId: 'p1', title: 'A', status: 'todo' },
      { id: 'i2', projectId: 'p1', title: 'B', status: 'doing' },
      { id: 'i3', projectId: 'p1', title: 'C', status: 'done' },
    ]);
    const issues = await api.listIssues({ projectId: 'p1', status: ['todo', 'doing'] });
    expect(issues.map((issue) => issue.id).sort()).toEqual(['i1', 'i2']);
    // Multi-status doesn't push the filter to the server.
    expect(client.listCalls[0].status).toBeUndefined();
  });

  test('listIssues respects limit', async () => {
    const { api } = makeApi([
      { id: 'i1', projectId: 'p1', title: 'A', status: 'todo' },
      { id: 'i2', projectId: 'p1', title: 'B', status: 'todo' },
      { id: 'i3', projectId: 'p1', title: 'C', status: 'todo' },
    ]);
    const issues = await api.listIssues({ projectId: 'p1', limit: 2 });
    expect(issues.map((issue) => issue.id)).toEqual(['i1', 'i2']);
  });

  test('getIssue returns normalized record', async () => {
    const { api } = makeApi([{ id: 'i1', projectId: 'p1', title: 'A', status: 'todo' }]);
    const issue = await api.getIssue('i1');
    expect(issue.id).toBe('i1');
    expect(issue.title).toBe('A');
  });

  test('createIssue stamps audit metadata under audit namespace + idempotency key', async () => {
    const { client, api } = makeApi();
    await api.createIssue({
      projectId: 'p1',
      title: 'Refactor X',
      priority: 'P2',
      clientRequestId: 'req-1',
      metadata: { source: 'chat' },
    });
    const body = client.createCalls[0];
    expect(body).toMatchObject({
      projectId: 'p1',
      title: 'Refactor X',
      priority: 'P2',
    });
    expect(body.metadata).toMatchObject({
      source: 'chat',
      clientRequestId: 'req-1',
      audit: {
        actor: 'sdk',
        sdkVersion: '0.0.0-test',
        invokedBy: null,
      },
    });
    // Audit fields must NOT leak to the top level (review M3 / H1).
    expect(body.metadata.actor).toBeUndefined();
    expect(body.metadata.sdkVersion).toBeUndefined();
  });

  test('createIssue lets caller-supplied metadata.audit beat SDK defaults', async () => {
    const { client, api } = makeApi();
    await api.createIssue({
      projectId: 'p1',
      title: 'X',
      metadata: { audit: { actor: 'cli', cliVersion: '0.2.0', invokedBy: 'claude-code' } },
    });
    expect(client.createCalls[0].metadata.audit).toMatchObject({
      actor: 'cli',
      cliVersion: '0.2.0',
      invokedBy: 'claude-code',
      sdkVersion: '0.0.0-test',
    });
    // Caller's `actor:"cli"` won over SDK default `"sdk"`.
    expect(client.createCalls[0].metadata.audit.actor).toBe('cli');
  });

  test('createIssue ignores top-level actor (cannot spoof outside audit namespace)', async () => {
    const { client, api } = makeApi();
    await api.createIssue({
      projectId: 'p1',
      title: 'X',
      // Caller tried to spoof at the top level; we expect it to be passed
      // through as a regular user field, NOT promoted to the audit object.
      metadata: { actor: 'system' as any },
    });
    expect(client.createCalls[0].metadata.audit.actor).toBe('sdk');
    // The top-level `actor` is preserved as a non-audit user field — server
    // strips it (see web-side test); SDK doesn't re-route it.
    expect(client.createCalls[0].metadata.actor).toBe('system');
  });

  test('updateIssue forwards subset patch + audit metadata', async () => {
    const { client, api } = makeApi([
      { id: 'i1', projectId: 'p1', title: 'A', status: 'todo' },
    ]);
    await api.updateIssue('i1', { title: 'A2', status: 'doing' });
    expect(client.patchCalls[0].body).toMatchObject({
      title: 'A2',
      status: 'doing',
    });
    expect(client.patchCalls[0].body.metadata.audit).toMatchObject({
      actor: 'sdk',
      sdkVersion: '0.0.0-test',
    });
  });

  test('updateIssueStatus without evidence is just a status patch', async () => {
    const { client, api } = makeApi([
      { id: 'i1', projectId: 'p1', title: 'A', status: 'doing' },
    ]);
    await api.updateIssueStatus('i1', 'done');
    expect(client.patchCalls).toHaveLength(1);
    expect(client.patchCalls[0].body.status).toBe('done');
  });

  test('updateIssueStatus with evidence merges metadata.qa.evidence + audit namespace', async () => {
    const { client, api } = makeApi([
      {
        id: 'i1',
        projectId: 'p1',
        title: 'A',
        status: 'doing',
        metadata: { custom: 'value' },
      },
    ]);
    await api.updateIssueStatus('i1', 'done', { evidence: 'all green' });
    const body = client.patchCalls[0].body;
    expect(body.status).toBe('done');
    expect(body.metadata).toMatchObject({
      custom: 'value',
      qa: { evidence: 'all green' },
      audit: {
        actor: 'sdk',
        sdkVersion: '0.0.0-test',
      },
    });
  });

  test('updateIssueStatus with evidence preserves existing qa metadata keys', async () => {
    const { client, api } = makeApi([
      {
        id: 'i1',
        projectId: 'p1',
        title: 'A',
        status: 'doing',
        metadata: { qa: { reviewedBy: 'alice' } },
      },
    ]);
    await api.updateIssueStatus('i1', 'done', { evidence: 'all green' });
    const body = client.patchCalls[0].body;
    expect(body.metadata.qa).toMatchObject({
      reviewedBy: 'alice',
      evidence: 'all green',
    });
  });

  test('updateIssueStatus passes caller metadata.audit through to PATCH', async () => {
    const { client, api } = makeApi([
      { id: 'i1', projectId: 'p1', title: 'A', status: 'doing' },
    ]);
    await api.updateIssueStatus('i1', 'done', {
      metadata: { audit: { actor: 'cli', cliVersion: '0.2.0' } },
    });
    expect(client.patchCalls[0].body.metadata.audit).toMatchObject({
      actor: 'cli',
      cliVersion: '0.2.0',
      sdkVersion: '0.0.0-test',
    });
  });

  test('deleteIssue forwards id', async () => {
    const { client, api } = makeApi([{ id: 'i1', projectId: 'p1', title: 'A' }]);
    await api.deleteIssue('i1');
    expect(client.deleteCalls).toEqual(['i1']);
  });

  test('getIssue maps 404 BackendApiError', async () => {
    const { api } = makeApi();
    await expect(api.getIssue('missing')).rejects.toBeInstanceOf(BackendApiError);
  });

  test('createIssue rejects when projectId/title missing', async () => {
    const { api } = makeApi();
    await expect(api.createIssue({ projectId: '', title: 'X' })).rejects.toThrow(/projectId/);
    await expect(api.createIssue({ projectId: 'p1', title: '' })).rejects.toThrow(/title/);
  });
});
