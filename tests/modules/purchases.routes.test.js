import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { purchasesRoutes } from '../../src/modules/purchases/purchases.routes.js';
import { can } from '../../src/shared/auth/role-matrix.js';

// Boot-level guard (see items.routes.test.js): every route/schema the purchases module wires up must
// exist, otherwise the real server crash-loops on start while the service unit tests stay green.
describe('purchases routes', () => {
  it('registers the approval, refund and supplier-invoice routes', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', {});
    app.decorate('storage', null);
    app.decorate('config', { IDEMPOTENCY_TTL_HOURS: 24 });
    app.decorateRequest('userContext', null);
    await app.register(purchasesRoutes, { prefix: '/api/purchases' });
    await app.ready();

    for (const [method, url] of [
      ['POST', '/api/purchases/:id/submit'],
      ['POST', '/api/purchases/:id/receive'],
      ['POST', '/api/purchases/:id/complete'],
      ['POST', '/api/purchases/:id/cancel'],
      ['POST', '/api/purchases/:id/refunds'],
      ['PUT', '/api/purchases/:id/supplier-invoice'],
      ['POST', '/api/purchases/:id/supplier-invoice-file'],
      ['GET', '/api/purchases/:id/supplier-invoice-file'],
      ['DELETE', '/api/purchases/:id/supplier-invoice-file']
    ]) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    await app.close();
  });
});

describe('purchases role matrix', () => {
  it('only admin-bu and admin-warehouse approve goods into stock; purchasing and finance cannot', () => {
    expect(can('admin-warehouse', 'purchases', 'approve')).toBe(true);
    expect(can('admin-bu', 'purchases', 'approve')).toBe(true);
    expect(can('purchasing', 'purchases', 'approve')).toBe(false);
    expect(can('finance', 'purchases', 'approve')).toBe(false);
    expect(can('owner', 'purchases', 'approve')).toBe(false);
  });

  it('refunds can be recorded by admin-bu, admin-warehouse and finance; purchasing creates but does not refund', () => {
    expect(can('finance', 'purchases', 'refund')).toBe(true);
    expect(can('admin-bu', 'purchases', 'refund')).toBe(true);
    expect(can('purchasing', 'purchases', 'refund')).toBe(false);
    expect(can('purchasing', 'purchases', 'write')).toBe(true);
  });
});
