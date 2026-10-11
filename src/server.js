import { buildApp } from './app.js';
import { startOwnerDigestScheduler } from './shared/scheduler/owner-digest-scheduler.js';

const app = await buildApp({
  logger: process.env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty' } }
    : true
});

try {
  await app.listen({ host: app.config.HOST, port: app.config.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

startOwnerDigestScheduler(app);
