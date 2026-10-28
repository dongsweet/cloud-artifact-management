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
import { createArtifactDispatcher } from './artifact-dispatcher.js';
import { LogCollectionStore } from './log-collection-store.js';
import { createLogCollectionDispatcher } from './log-collection-dispatcher.js';
import { SourceConfigStore } from './source-config-store.js';

const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/edge' : join(process.cwd(), 'data', 'edge'));

export async function buildEdgeApp({ dataDir = DEFAULT_DATA_DIR, defaultChunkSize = Number(process.env.CHUNK_SIZE ?? DEFAULT_CHUNK_SIZE), allowlist, principalProvider = null, secureCookies, fetchImpl = fetch } = {}) {
  const db = await openDatabase(join(dataDir, 'edge.sqlite'));
  const configuredMaxCandidateSize = Number(process.env.CAM_MAX_CANDIDATE_SIZE ?? 2 * 1024 * 1024 * 1024 * 1024);
  const maxCandidateSize = Number.isSafeInteger(configuredMaxCandidateSize) && configuredMaxCandidateSize > 0 ? Math.min(8 * 1024 * 1024 * 1024 * 1024, configuredMaxCandidateSize) : 2 * 1024 * 1024 * 1024 * 1024;
  const store = new CandidateStore({ db, dataDir, defaultChunkSize, maxCandidateSize });
  const sourceConfig = new SourceConfigStore(db, { initialAllowlist: allowlist });
  const receiver = createCandidateReceiver({ store, allowlistProvider: () => sourceConfig.get().allowlist, maxSourceSize: maxCandidateSize, finalize: (candidateId) => finalizeCandidate(store, candidateId) });
  const scheduler = createReceiveScheduler({ store, receiver });
  const downloadGrants = new DownloadGrantStore({ db, candidateStore: store });
  const auth = new AuthStore(db);
  const freezes = new FreezeStore({ db, dataDir, candidateStore: store });
  // The control endpoint is part of the deployment bootstrap path: changing it
  // from the UI can make Edge unable to delegate authentication to Core.  In the
  // production container the deployment value is authoritative and the API/UI
  // expose it as read-only.  Non-production in-process tests keep the database
  // fallback so they can bootstrap a pair without a compose environment.
  const gateConfig = new GateConfigStore(db, {
    table: 'edge_gate_config',
    eventsTable: 'edge_gate_config_events',
    requiredUrlFields: ['coreControlUrl', 'coreTransferUrl'],
    envOnlyFields: process.env.NODE_ENV === 'production' ? ['coreControlUrl'] : []
  });
  const keyring = new GateKeyring({ filePath: join(dataDir, 'gate-keyring.json'), role: 'edge' });
  await keyring.ready;
  const approvalDispatcher = createApprovalDispatcher({ freezes, gateConfig, keyring });
  const artifactDispatcher = createArtifactDispatcher({ freezes, candidates: store, gateConfig, keyring });
  const logCollections = new LogCollectionStore({ db, dataDir });
  const logCollectionDispatcher = createLogCollectionDispatcher({ store: logCollections, gateConfig, keyring, dataDir, fetchImpl });
  const app = await buildServer({
    service: 'cam-edge',
    configure: async (server) => {
      registerAuth(server, { auth, principalProvider, keyring, gateConfig, fetchImpl, secureCookies });
      registerCandidateRoutes(server, { store, receiver, scheduler, downloadGrants, auth, freezes, gateConfig, sourceConfig, keyring, approvalDispatcher, artifactDispatcher, logCollections: logCollectionDispatcher });
      server.addHook('onClose', async () => { await artifactDispatcher.close(); await approvalDispatcher.close(); await scheduler.close(); logCollectionDispatcher.close(); await db.close(); });
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
  app.decorate('sourceConfigStore', sourceConfig);
  app.decorate('gateKeyring', keyring);
  app.decorate('approvalDispatcher', approvalDispatcher);
  app.decorate('artifactDispatcher', artifactDispatcher);
  app.decorate('logCollectionDispatcher', logCollectionDispatcher);
  queueMicrotask(() => { scheduler.start(); approvalDispatcher.start(); artifactDispatcher.start(); });
  logCollectionDispatcher.start();
  return app;
}

export async function createEdgeServer({ port = Number(process.env.PORT ?? 3101), host = process.env.HOST ?? '127.0.0.1', ...options } = {}) {
  const app = await buildEdgeApp(options);
  await app.listen({ port, host });
  return app;
}
