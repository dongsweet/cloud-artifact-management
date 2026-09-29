import { createServer } from '../../../libs/cam-server/src/server.js';

await createServer({ service: 'cam-core', port: Number(process.env.PORT ?? 3102) });
