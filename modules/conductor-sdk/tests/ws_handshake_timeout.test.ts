import net from 'node:net';
import { afterEach, expect, test } from 'vitest';

import { defaultConnectImpl } from '../src/ws/client.js';

let server: net.Server | null = null;
const sockets: net.Socket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

test('rejects a handshake the server never answers instead of hanging', async () => {
  // Accepts the TCP connection but never replies to the upgrade request,
  // like a link that stalls mid-handshake.
  server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  await expect(
    defaultConnectImpl(`ws://127.0.0.1:${port}`, { headers: {}, handshakeTimeout: 200 }),
  ).rejects.toThrow(/handshake has timed out/i);
});
