import Fastify from 'fastify';

export async function createServer({ service, port, host = process.env.HOST ?? '127.0.0.1' }) {
  const app = Fastify({ logger: true });
  app.get('/health/live', async () => ({ service, status: 'ok' }));
  app.get('/health/ready', async () => ({ service, status: 'ready' }));
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
  await app.listen({ port, host });
  return app;
}
