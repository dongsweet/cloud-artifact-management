import { createServer } from '../../../libs/cam-server/src/server.js';

await createServer({ service: 'cam-edge', port: Number(process.env.PORT ?? 3101) });
