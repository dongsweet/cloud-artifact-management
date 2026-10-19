import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from '../../../libs/cam-server/src/server.js';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { CoreStore } from './core-store.js';
import { CloudAdapter } from './cloud-adapter.js';
import { registerCoreRoutes } from './routes.js';
import { registerCoreAuth, AuthStore } from './auth.js';
import { GateConfigStore } from '../../../libs/cam-gate/src/config.js';
import { GateKeyring } from '../../../libs/cam-gate/src/keyring.js';
import { signResponse } from '../../../libs/cam-agent-auth/src/protocol.js';
import { loadAgentServiceIdentity, rotateAgentServiceIdentity } from './agent-service-identity.js';

const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/core' : join(process.cwd(), 'data', 'core'));

export async function buildCoreApp({ dataDir = DEFAULT_DATA_DIR, cloudAdapter = new CloudAdapter(), enableAuth = true, enableKeyRotation = process.env.NODE_ENV === 'production', cloudRetryDelayMs, cloudStatusPollMs, approvalResultRetryBaseMs, workerIntervalMs, fetchImpl = fetch } = {}) {
  const db = await openDatabase(join(dataDir, 'core.sqlite'));
  const agentServiceIdentity = await loadAgentServiceIdentity(join(dataDir, 'core-agent-identity.json'));
  const agentServiceIdentityPath = join(dataDir, 'core-agent-identity.json');
  const store = new CoreStore(db, { dataDir });
  const auth = new AuthStore(db);
  const gateConfig = new GateConfigStore(db, { table: 'core_gate_config', eventsTable: 'core_gate_config_events', requiredUrlFields: ['edgeControlUrl', 'edgeTransferUrl'] });
  const keyring = new GateKeyring({ filePath: join(dataDir, 'gate-keyring.json'), role: 'core' });
  await keyring.ready;
  const app = await buildServer({
    service: 'cam-core',
    configure: async (server) => {
      registerCoreRoutes(server, { store, cloud: cloudAdapter, gateConfig, keyring, agentServiceIdentity, rotateAgentServiceIdentity: async () => { const next = await rotateAgentServiceIdentity(agentServiceIdentityPath, agentServiceIdentity); Object.assign(agentServiceIdentity, next); return { publicKey: next.publicKeyPem, fingerprint: next.fingerprint, previousPublicKey: next.previousPublicKeyPem, previousFingerprint: next.previousFingerprint, previousKeyExpiresAt: next.previousKeyExpiresAt }; }, enableKeyRotation, cloudRetryDelayMs, cloudStatusPollMs, approvalResultRetryBaseMs, workerIntervalMs, fetchImpl });
      server.addHook('onSend', async (request, reply, payload) => {
        if (!request.url.startsWith('/api/v1/agent/')) return payload;
        const nonce = request.headers['x-cam-agent-nonce'];
        if (typeof nonce !== 'string' || !nonce) return payload;
        let body = payload ?? '';
        // Fastify exposes streamed file responses as an async iterable. Buffer
        // the bounded Agent chunk so the signature covers the exact bytes that
        // will be sent and the caller can still consume the returned payload.
        if (body && typeof body[Symbol.asyncIterator] === 'function') {
          const chunks = [];
          for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          body = Buffer.concat(chunks);
        }
        const timestamp = new Date().toISOString();
        reply.header('x-cam-core-key-id', agentServiceIdentity.fingerprint);
        reply.header('x-cam-core-timestamp', timestamp);
        reply.header('x-cam-core-signature', signResponse(agentServiceIdentity.privateKeyPem, reply.statusCode, request.method, request.url.split('?')[0], nonce, timestamp, body));
        return body;
      });
      if (enableAuth) registerCoreAuth(server, { auth });
      server.addHook('onClose', async () => db.close());
    }
  });
  app.decorate('coreStore', store);
  app.decorate('cloudAdapter', cloudAdapter);
  app.decorate('authStore', auth);
  app.decorate('gateConfigStore', gateConfig);
  app.decorate('gateKeyring', keyring);
  app.decorate('agentServiceIdentity', agentServiceIdentity);
  return app;
}

export async function createCoreServer({ port = Number(process.env.PORT ?? 3102), host = process.env.HOST ?? '127.0.0.1', ...options } = {}) {
  const app = await buildCoreApp(options);
  await app.listen({ port, host });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await createCoreServer();
