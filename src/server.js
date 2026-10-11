import { buildApp } from './app.js';
import { startOwnerDigestScheduler } from './shared/scheduler/owner-digest-scheduler.js';

const app = await buildApp({
  logger: process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty' } }
    : true
});

// Must run BEFORE listen(): it registers an onClose hook, and Fastify refuses addHook() once the
// instance is listening. The timers only start ticking 30s later, well after the server is up.
startOwnerDigestScheduler(app);

try {
  await app.listen({ host: app.config.HOST, port: app.config.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
