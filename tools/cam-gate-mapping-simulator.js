#!/usr/bin/env node

/**
 * Test-only HTTP mapping proxy for the direct-connect compose deployment.
 *
 * It models four narrowly scoped Hillstone mapping endpoints without trying to
 * emulate a security gateway.  Each listener has one fixed upstream target;
 * requests are streamed in both directions so large bodies are not buffered.
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { URL } from 'node:url';

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const CHANNEL_ENV = Object.freeze({
  coreControl: ['CAM_GATE_SIM_CORE_CONTROL_PORT', 'CAM_GATE_SIM_CORE_CONTROL_TARGET', 3201],
  coreTransfer: ['CAM_GATE_SIM_CORE_TRANSFER_PORT', 'CAM_GATE_SIM_CORE_TRANSFER_TARGET', 3202],
  edgeControl: ['CAM_GATE_SIM_EDGE_CONTROL_PORT', 'CAM_GATE_SIM_EDGE_CONTROL_TARGET', 3203],
  edgeTransfer: ['CAM_GATE_SIM_EDGE_TRANSFER_PORT', 'CAM_GATE_SIM_EDGE_TRANSFER_TARGET', 3204]
});

function validPort(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`invalid port: ${value}`);
  return parsed;
}

function targetUrl(value, channel) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${channel} target must use http or https`);
  return parsed;
}

function copyHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'host') result[name] = value;
  }
  return result;
}

function normalizeError(error) {
  return error?.code === 'UND_ERR_HEADERS_TIMEOUT' ? 'upstream headers timeout' : error?.message ?? 'upstream request failed';
}

export function createMappingSimulator({ bind = process.env.CAM_GATE_SIM_BIND ?? '0.0.0.0', channels = {} } = {}) {
  const servers = [];
  const resolved = {};

  for (const [name, [portEnv, targetEnv, defaultPort]] of Object.entries(CHANNEL_ENV)) {
    const configured = channels[name] ?? {};
    const port = validPort(configured.port ?? process.env[portEnv], defaultPort);
    const target = targetUrl(configured.target ?? process.env[targetEnv] ?? 'http://127.0.0.1:3102', name);
    resolved[name] = { name, port, target };

    const server = createServer((request, response) => {
      if (request.method === 'CONNECT' || request.headers.upgrade) {
        response.writeHead(405, { 'content-type': 'application/json', 'connection': 'close' });
        response.end(JSON.stringify({ error: 'protocol_not_supported' }));
        return;
      }
      if (request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: 'ok', channel: name, target: target.origin }));
        return;
      }

      const headers = copyHeaders(request.headers);
      headers.host = target.host;
      headers['x-cam-gate-simulator'] = 'cam-gate-sim';
      headers['x-cam-gate-channel'] = name;
      const requestUpstream = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstreamRequest = requestUpstream({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: request.method,
        path: request.url || '/',
        headers,
        timeout: Number(process.env.CAM_GATE_SIM_UPSTREAM_TIMEOUT_MS ?? 60000)
      }, (upstreamResponse) => {
        const responseHeaders = copyHeaders(upstreamResponse.headers);
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      });

      const fail = (error) => {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(error?.code === 'ETIMEDOUT' ? 504 : 502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ error: 'mapping_upstream_failed', message: normalizeError(error) }));
        }
      };
      upstreamRequest.on('error', fail);
      upstreamRequest.on('timeout', () => upstreamRequest.destroy(Object.assign(new Error('upstream request timeout'), { code: 'ETIMEDOUT' })));
      request.on('aborted', () => upstreamRequest.destroy());
      response.on('close', () => { if (!response.writableFinished) upstreamRequest.destroy(); });
      request.pipe(upstreamRequest);
    });
    servers.push({ name, port, target, server });
  }

  return {
    channels: resolved,
    async listen() {
      await Promise.all(servers.map(({ server, port, name }) => new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => {
          resolved[name].port = server.address().port;
          resolve();
        });
      })));
      return this;
    },
    async close() {
      await Promise.all(servers.map(({ server }) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const simulator = createMappingSimulator();
  await simulator.listen();
  for (const channel of Object.values(simulator.channels)) {
    process.stdout.write(`cam-gate-sim ${channel.name} listening on ${channel.port} -> ${channel.target.origin}\n`);
  }
  const shutdown = async () => { await simulator.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
