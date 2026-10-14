import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createMappingSimulator } from './cam-gate-mapping-simulator.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('mapping simulator forwards health and streams requests to fixed channel targets', async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, url: request.url, channel: request.headers['x-cam-gate-channel'], body: Buffer.concat(chunks).toString() });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ channel: request.headers['x-cam-gate-channel'], bodyBytes: Buffer.concat(chunks).length }));
  });
  const upstreamPort = await listen(upstream);
  const simulator = createMappingSimulator({
    bind: '127.0.0.1',
    channels: Object.fromEntries(['coreControl', 'coreTransfer', 'edgeControl', 'edgeTransfer'].map((name) => [name, { port: 0, target: `http://127.0.0.1:${upstreamPort}` }]))
  });

  // Port zero is useful in tests; collect the OS-selected ports after listen.
  await simulator.listen();
  try {
    for (const [index, channel] of Object.values(simulator.channels).entries()) {
      const health = await fetch(`http://127.0.0.1:${channel.port}/healthz`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).channel, channel.name);

      const payload = `mapping-test-${channel.name}`;
      const response = await fetch(`http://127.0.0.1:${channel.port}/api/v1/test?channel=${index}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: payload
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { channel: channel.name, bodyBytes: Buffer.byteLength(payload) });
    }
    assert.deepEqual(received.map(({ method, url, channel, body }) => ({ method, url, channel, body })), Object.values(simulator.channels).map((channel, index) => ({ method: 'POST', url: `/api/v1/test?channel=${index}`, channel: channel.name, body: `mapping-test-${channel.name}` })));
  } finally {
    await simulator.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
