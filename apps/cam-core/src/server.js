import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from '../../../libs/cam-server/src/server.js';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { CoreStore } from './core-store.js';
import { CloudAdapter } from './cloud-adapter.js';
import { registerCoreRoutes } from './routes.js';
import { registerCoreAuth, AuthStore } from './auth.js';
import { GateConfigStore } from '../../../libs/cam-gate/src/config.js';

const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/core' : join(process.cwd(), 'data', 'core'));

export async function buildCoreApp({ dataDir = DEFAULT_DATA_DIR, cloudAdapter = new CloudAdapter(), gateSecret = process.env.CAM_GATE_SHARED_SECRET, previousGateSecret = process.env.CAM_GATE_PREVIOUS_SHARED_SECRET, enableAuth = true } = {}) {
  const db = await openDatabase(join(dataDir, 'core.sqlite'));
  const store = new CoreStore(db);
  const auth = new AuthStore(db);
  const gateConfig = new GateConfigStore(db, { table: 'core_gate_config', eventsTable: 'core_gate_config_events' });
  const app = await buildServer({
    service: 'cam-core',
    configure: async (server) => {
      registerCoreRoutes(server, { store, cloud: cloudAdapter, gateSecret, previousGateSecret, gateConfig });
      if (enableAuth) registerCoreAuth(server, { auth });
      server.addHook('onClose', async () => db.close());
    }
  });
  app.decorate('coreStore', store);
  app.decorate('cloudAdapter', cloudAdapter);
  app.decorate('authStore', auth);
  app.decorate('gateConfigStore', gateConfig);
  return app;
}

export async function createCoreServer({ port = Number(process.env.PORT ?? 3102), host = process.env.HOST ?? '127.0.0.1', ...options } = {}) {
  const app = await buildCoreApp(options);
  await app.listen({ port, host });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await createCoreServer();
