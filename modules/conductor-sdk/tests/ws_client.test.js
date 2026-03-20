import { describe, expect, test } from 'vitest';
import { ConductorWebSocketClient } from '../src/ws/index.js';
import { ConductorConfig } from '../src/config/index.js';
function makeConfig() {
    return new ConductorConfig({
        agentToken: 'token',
        backendUrl: 'https://backend.local',
    });
}
class FakeSocket {
    sent = [];
    closed = false;
    queue = [];
    waiters = [];
    pongHandlers = [];
    feed(payload) {
        const message = JSON.stringify(payload);
        if (this.waiters.length) {
            const resolve = this.waiters.shift();
            resolve(message);
        }
        else {
            this.queue.push(message);
        }
    }
    async send(data) {
        this.sent.push(data);
    }
    async ping() {
        if (this.closed) {
            throw new Error('closed');
        }
        queueMicrotask(() => {
            for (const handler of this.pongHandlers) {
                handler();
            }
        });
    }
    async close() {
        this.closed = true;
        this.enqueue(null);
    }
    async terminate() {
        await this.close();
    }
    onPong(handler) {
        this.pongHandlers.push(handler);
    }
    enqueue(value) {
        if (this.waiters.length) {
            const resolve = this.waiters.shift();
            resolve(value);
        }
        else {
            this.queue.push(value);
        }
    }
    nextValue() {
        if (this.queue.length) {
            const value = this.queue.shift() ?? null;
            return Promise.resolve(value);
        }
        return new Promise((resolve) => this.waiters.push(resolve));
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            const value = await this.nextValue();
            if (value === null) {
                return;
            }
            yield value;
        }
    }
}
describe('ConductorWebSocketClient', () => {
    test('dispatches backend events to handlers', async () => {
        const connections = [];
        const client = new ConductorWebSocketClient(makeConfig(), {
            reconnectDelay: 10,
            heartbeatInterval: 10,
            connectImpl: async () => {
                const socket = new FakeSocket();
                connections.push(socket);
                return socket;
            },
        });
        const received = [];
        client.registerHandler(async (payload) => {
            received.push(payload);
        });
        await client.connect();
        connections[0].feed({ type: 'task_user_message' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(received).toEqual([{ type: 'task_user_message' }]);
        await client.disconnect();
    });
    test('reconnects after close and can send payloads', async () => {
        const connections = [];
        const client = new ConductorWebSocketClient(makeConfig(), {
            reconnectDelay: 10,
            heartbeatInterval: 10,
            connectImpl: async () => {
                const socket = new FakeSocket();
                connections.push(socket);
                return socket;
            },
        });
        await client.connect();
        await connections[0].close();
        await new Promise((resolve) => setTimeout(resolve, 30));
        await client.sendJson({ type: 'ping' });
        expect(connections.length).toBeGreaterThanOrEqual(2);
        const last = connections[connections.length - 1];
        expect(JSON.parse(last.sent.at(-1))).toEqual({ type: 'ping' });
        await client.disconnect();
    });
    test('forces reconnect when pong is missing', async () => {
        class NoPongSocket extends FakeSocket {
            async ping() {
                if (this.closed) {
                    throw new Error('closed');
                }
            }
        }
        const connections = [];
        const disconnectReasons = [];
        const client = new ConductorWebSocketClient(makeConfig(), {
            reconnectDelay: 10,
            heartbeatInterval: 10,
            onDisconnected: (event) => {
                disconnectReasons.push(event.reason);
            },
            connectImpl: async () => {
                const socket = connections.length === 0 ? new NoPongSocket() : new FakeSocket();
                connections.push(socket);
                return socket;
            },
        });
        await client.connect();
        await new Promise((resolve) => setTimeout(resolve, 35));
        expect(disconnectReasons).toContain('pong_timeout');
        expect(connections.length).toBeGreaterThanOrEqual(2);
        await client.disconnect();
    });
    test('does not require onPong support for legacy socket adapters', async () => {
        const connections = [];
        const disconnectReasons = [];
        const client = new ConductorWebSocketClient(makeConfig(), {
            reconnectDelay: 10,
            heartbeatInterval: 10,
            onDisconnected: (event) => {
                disconnectReasons.push(event.reason);
            },
            connectImpl: async () => {
                const socket = new FakeSocket();
                socket.onPong = undefined;
                connections.push(socket);
                return socket;
            },
        });
        await client.connect();
        await new Promise((resolve) => setTimeout(resolve, 35));
        await client.sendJson({ type: 'ping' });
        expect(disconnectReasons).toEqual([]);
        expect(connections).toHaveLength(1);
        expect(JSON.parse(connections[0].sent.at(-1))).toEqual({ type: 'ping' });
        await client.disconnect();
    });
});
