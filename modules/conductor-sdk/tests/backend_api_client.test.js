import { describe, expect, test } from 'vitest';
import { BackendApiClient, BackendApiError } from '../src/backend/index.js';
import { ConductorConfig } from '../src/config/index.js';
function makeConfig() {
    return new ConductorConfig({
        agentToken: 'token',
        backendUrl: 'https://backend.local',
    });
}
describe('BackendApiClient', () => {
    test('listProjects returns summaries', async () => {
        const fetchImpl = async (url, init) => {
            expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
            return new Response(JSON.stringify([
                { id: 'p1', name: 'Demo', description: 'Project' },
                { id: 'p2', name: null },
                { name: 'missing-id' },
            ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        const client = new BackendApiClient(makeConfig(), { fetchImpl });
        const projects = await client.listProjects();
        expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']);
        expect(projects[0].name).toBe('Demo');
    });
    test('listProjects handles HTTP errors', async () => {
        const fetchImpl = async () => new Response('boom', { status: 500 });
        const client = new BackendApiClient(makeConfig(), { fetchImpl });
        await expect(client.listProjects()).rejects.toBeInstanceOf(BackendApiError);
    });
    test('listProjects validates response shape', async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 });
        const client = new BackendApiClient(makeConfig(), { fetchImpl });
        await expect(client.listProjects()).rejects.toBeInstanceOf(BackendApiError);
    });
});
