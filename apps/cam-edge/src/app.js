import { join } from 'node:path';
import { buildServer } from '../../../libs/cam-server/src/server.js';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { DEFAULT_CHUNK_SIZE } from '../../../libs/cam-transfer/src/transfer.js';
import { CandidateStore } from './candidate-store.js';
import { createCandidateReceiver } from './candidate-receiver.js';
import { createReceiveScheduler } from './receive-scheduler.js';
import { finalizeCandidate, registerCandidateRoutes } from './routes.js';
import { DownloadGrantStore } from './download-grant-store.js';
import { AuthStore } from './auth-store.js';
import { registerAuth } from './auth.js';
import { FreezeStore } from './freeze-store.js';
import { GateConfigStore } from '../../../libs/cam-gate/src/config.js';
import { GateKeyring } from '../../../libs/cam-gate/src/keyring.js';
import { createApprovalDispatcher } from './approval-dispatcher.js';

const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/edge' : join(process.cwd(), 'data', 'edge'));

export async function buildEdgeApp({ dataDir = DEFAULT_DATA_DIR, defaultChunkSize = Number(process.env.CHUNK_SIZE ?? DEFAULT_CHUNK_SIZE), allowlist, principalProvider = null, secureCookies, gateSecret = process.env.CAM_GATE_SHARED_SECRET, previousGateSecret = process.env.CAM_GATE_PREVIOUS_SHARED_SECRET } = {}) {
  const db = await openDatabase(join(dataDir, 'edge.sqlite'));
  const store = new CandidateStore({ db, dataDir, defaultChunkSize });
  const receiver = createCandidateReceiver({ store, allowlist, finalize: (candidateId) => finalizeCandidate(store, candidateId) });
  const scheduler = createReceiveScheduler({ store, receiver });
  const downloadGrants = new DownloadGrantStore({ db, candidateStore: store });
  const auth = new AuthStore(db);
  const freezes = new FreezeStore({ db, dataDir, candidateStore: store });
  const gateConfig = new GateConfigStore(db, { table: 'edge_gate_config', eventsTable: 'edge_gate_config_events', requiredUrlFields: ['coreControlUrl', 'coreTransferUrl'] });
  const keyring = new GateKeyring({ filePath: join(dataDir, 'gate-keyring.json'), role: 'edge', bootstrapSecret: gateSecret, bootstrapPreviousSecret: previousGateSecret });
  await keyring.ready;
  const approvalDispatcher = createApprovalDispatcher({ freezes, gateConfig, keyring });
  const app = await buildServer({
    service: 'cam-edge',
    configure: async (server) => {
      registerAuth(server, { auth, principalProvider, secureCookies });
      registerCandidateRoutes(server, { store, receiver, scheduler, downloadGrants, auth, freezes, gateConfig, keyring, approvalDispatcher });
      server.addHook('onClose', async () => { await approvalDispatcher.close(); await scheduler.close(); await db.close(); });
    }
  });
  downloadGrants.setLogger(app.log);
  app.decorate('candidateStore', store);
  app.decorate('candidateReceiver', receiver);
  app.decorate('receiveScheduler', scheduler);
  app.decorate('downloadGrantStore', downloadGrants);
  app.decorate('authStore', auth);
  app.decorate('freezeStore', freezes);
  app.decorate('gateConfigStore', gateConfig);
  app.decorate('gateKeyring', keyring);
  app.decorate('approvalDispatcher', approvalDispatcher);
  queueMicrotask(() => { scheduler.start(); approvalDispatcher.start(); });
  return app;
}

export async function createEdgeServer({ port = Number(process.env.PORT ?? 3101), host = process.env.HOST ?? '127.0.0.1', ...options } = {}) {
  const app = await buildEdgeApp(options);
  await app.listen({ port, host });
  return app;
}
