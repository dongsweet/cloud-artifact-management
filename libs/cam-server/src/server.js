import Fastify from 'fastify';

export async function buildServer({ service, configure, bodyLimit = Number(process.env.BODY_LIMIT ?? 25 * 1024 * 1024) } = {}) {
  const app = Fastify({ logger: true, bodyLimit });
  app.addContentTypeParser('application/octet-stream', (_request, _payload, done) => done());
  app.addContentTypeParser('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { parseAs: 'buffer' }, (_request, payload, done) => done(null, payload));
  app.get('/health/live', async () => ({ service, status: 'ok' }));
  app.get('/health/ready', async () => ({ service, status: 'ready' }));
  if (configure) await configure(app);
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
  return app;
}

export async function createServer({ service, port, host = process.env.HOST ?? '127.0.0.1', configure } = {}) {
  const app = await buildServer({ service, configure });
  await app.listen({ port, host });
  return app;
}
