import { createServer } from '../../../libs/cam-server/src/server.js';

await createServer({ service: 'cam-agent', port: Number(process.env.PORT ?? 3103) });
