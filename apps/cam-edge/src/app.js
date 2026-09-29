import { join } from 'node:path';
import { buildServer } from '../../../libs/cam-server/src/server.js';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { DEFAULT_CHUNK_SIZE } from '../../../libs/cam-transfer/src/transfer.js';
import { CandidateStore } from './candidate-store.js';
import { createCandidateReceiver } from './candidate-receiver.js';
import { registerCandidateRoutes } from './routes.js';

export async function buildEdgeApp({ dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data', 'edge'), defaultChunkSize = Number(process.env.CHUNK_SIZE ?? DEFAULT_CHUNK_SIZE), allowlist } = {}) {
  const db = await openDatabase(join(dataDir, 'edge.sqlite'));
  const store = new CandidateStore({ db, dataDir, defaultChunkSize });
  const receiver = createCandidateReceiver({ store, allowlist });
  const app = await buildServer({
    service: 'cam-edge',
    configure: async (server) => {
      registerCandidateRoutes(server, { store, receiver });
      server.addHook('onClose', async () => db.close());
    }
  });
  app.decorate('candidateStore', store);
  app.decorate('candidateReceiver', receiver);
  return app;
}

export async function createEdgeServer({ port = Number(process.env.PORT ?? 3101), host = process.env.HOST ?? '127.0.0.1', ...options } = {}) {
  const app = await buildEdgeApp(options);
  await app.listen({ port, host });
  return app;
}
