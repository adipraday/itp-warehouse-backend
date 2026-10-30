import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { salesRoutes } from '../../src/modules/sales/sales.routes.js';
import { itemsRoutes } from '../../src/modules/items/items.routes.js';
import { purchasesRoutes } from '../../src/modules/purchases/purchases.routes.js';
import { activityLogsRoutes } from '../../src/modules/activity-logs/activity-logs.routes.js';

// HTTP-level proof for the partner identity `integration-readonly` (auth-backend docs/api-tokens.md):
// real routes, real onRequest guards, identity injected the way user-context.js would after a JWT
// check. Every guard runs BEFORE validation and DB access, so a stub `db` is enough to see the 403.
async function buildApp(role) {
  const app = Fastify({ logger: false });
  app.decorate('db', {});
  app.decorate('storage', null);
  app.decorate('config', { IDEMPOTENCY_TTL_HOURS: 24 });
  app.decorateRequest('userContext', null);
  app.addHook('onRequest', async (request) => {
    request.userContext = { userId: 9, role, buId: 7, buIds: [7] };
  });
  await app.register(salesRoutes, { prefix: '/api/sales' });
  await app.register(itemsRoutes, { prefix: '/api/items' });
  await app.register(purchasesRoutes, { prefix: '/api/purchases' });
  await app.register(activityLogsRoutes, { prefix: '/api/activity-logs' });
  await app.ready();
  return app;
}

describe('integration-readonly over HTTP', () => {
  it('gets 403 on every kind of write, whatever the body', async () => {
    const app = await buildApp('integration-readonly');

    for (const [method, url] of [
      ['POST', '/api/sales'],
      ['PUT', '/api/sales/1'],
      ['DELETE', '/api/sales/1'],
      ['POST', '/api/sales/1/complete'],
      ['POST', '/api/items'],
      ['POST', '/api/purchases'],
      ['POST', '/api/purchases/1/receive'],
      ['POST', '/api/purchases/1/refunds']
    ]) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
  });

  it('names the role and the refused action in the 403 message', async () => {
    const app = await buildApp('integration-readonly');
    const res = await app.inject({ method: 'POST', url: '/api/sales', payload: {} });
    expect(res.json().message).toBe('Role "integration-readonly" may not write sales');
    await app.close();
  });

  it('gets 403 on activity logs (list and detail)', async () => {
    const app = await buildApp('integration-readonly');

    for (const url of ['/api/activity-logs', '/api/activity-logs/1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(403);
    }
    await app.close();
  });

  it('is the ONLY role refused on activity logs — other roles still get past the guard', async () => {
    for (const role of ['owner', 'admin-bu', 'admin-warehouse', 'staff-gudang']) {
      const app = await buildApp(role);
      const res = await app.inject({ method: 'GET', url: '/api/activity-logs' });
      // Past the role guard the stub db makes the handler fail — anything but 403 proves the guard let it through.
      expect(res.statusCode, role).not.toBe(403);
      await app.close();
    }
  });

  it('control: owner (the other view-only role) is also 403 on writes, so the two behave alike', async () => {
    const app = await buildApp('owner');
    const res = await app.inject({ method: 'POST', url: '/api/sales', payload: {} });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
