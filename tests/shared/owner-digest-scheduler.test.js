import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { startOwnerDigestScheduler } from '../../src/shared/scheduler/owner-digest-scheduler.js';

function appWith(config) {
  const app = Fastify({ logger: false });
  app.decorate('config', config);
  app.decorate('db', {});
  return app;
}

describe('startOwnerDigestScheduler', () => {
  // Regression: it registers an onClose hook, so calling it after listen() crashed the server on
  // boot (FST_ERR_INSTANCE_ALREADY_LISTENING) and put production in a restart loop.
  it('can be started before listen() and is cleaned up on close', async () => {
    const app = appWith({ OWNER_DIGEST_ENABLED: true, OWNER_DIGEST_HOUR: 7 });

    const timer = startOwnerDigestScheduler(app);
    expect(timer).not.toBeNull();

    await app.listen({ host: '127.0.0.1', port: 0 });
    await app.close();
  });

  it('refuses to be started once the app is already listening (documents the ordering rule)', async () => {
    const app = appWith({ OWNER_DIGEST_ENABLED: true, OWNER_DIGEST_HOUR: 7 });
    await app.listen({ host: '127.0.0.1', port: 0 });

    expect(() => startOwnerDigestScheduler(app)).toThrow(/already listening/i);
    await app.close();
  });

  it('does nothing when disabled', () => {
    const app = appWith({ OWNER_DIGEST_ENABLED: false, OWNER_DIGEST_HOUR: 7 });
    expect(startOwnerDigestScheduler(app)).toBeNull();
  });
});
