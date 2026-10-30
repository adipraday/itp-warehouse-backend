import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import * as repository from '../../src/modules/item-requests/item-requests.repository.js';
import * as warehousesRepository from '../../src/modules/warehouses/warehouses.repository.js';
import * as service from '../../src/modules/item-requests/item-requests.service.js';
import { itemRequestsRoutes } from '../../src/modules/item-requests/item-requests.routes.js';
import { salesRoutes } from '../../src/modules/sales/sales.routes.js';
import { stocksRoutes } from '../../src/modules/inventory/stocks/stocks.routes.js';
import { activityLogsRoutes } from '../../src/modules/activity-logs/activity-logs.routes.js';
import { warehousesRoutes } from '../../src/modules/warehouses/warehouses.routes.js';
import { notifyStakeholders, notifyUsers } from '../../src/shared/notifications/push.js';
import {
  can,
  ROLES,
  HPP_VISIBLE_ROLES,
  INTEGRATION_REQUESTER_ROLE,
  integrationScope
} from '../../src/shared/auth/role-matrix.js';
import { STAFF_ROLES } from '../../src/shared/auth/warehouse-assignment.js';

vi.mock('../../src/modules/item-requests/item-requests.repository.js');
vi.mock('../../src/modules/warehouses/warehouses.repository.js');
vi.mock('../../src/shared/notifications/push.js', () => ({
  notifyStakeholders: vi.fn(async () => {}),
  notifyUsers: vi.fn(async () => {})
}));

// integration-requester (2026-10-31): the identity behind an external system (e.g. an ERP) that files
// item requests through an auth-backend API key (docs/api-tokens.md there). Least privilege.
const role = INTEGRATION_REQUESTER_ROLE;
const erp = { userId: 40, role, buId: 3, buIds: [3] };
const db = {};

function row(overrides = {}) {
  return { id: 1, request_number: 'REQ-000001', bu_id: 3, warehouse_id: null, requested_by: 40, subject: 'x', status: 'OPEN', ...overrides };
}

describe('integration-requester: role matrix', () => {
  it('is declared under the exact name auth-backend issues', () => {
    expect(role).toBe('integration-requester');
    expect(ROLES).toContain(role);
  });

  it('may file and withdraw item requests, but never handle them', () => {
    expect(can(role, 'item-requests', 'write')).toBe(true);
    expect(can(role, 'item-requests', 'handle')).toBe(false);
  });

  it('is denied EVERY other mutating action on EVERY other resource', () => {
    const resources = [
      'warehouses', 'user-warehouse-assignments', 'items', 'contacts', 'inbounds', 'outbounds',
      'stock-transfers', 'stock-opnames', 'returns', 'sales', 'cash-sessions', 'purchases', 'payments',
      'stocks', 'stock-mutations', 'cost-layers', 'cost-summary', 'invoices', 'dashboard', 'activity-logs',
      'nonexistent-resource'
    ];
    for (const resource of resources) {
      for (const action of ['write', 'approve', 'submit', 'reject', 'refund', 'handle']) {
        expect(can(role, resource, action), `${resource}:${action}`).toBe(false);
      }
    }
  });

  it('cannot see HPP / cost data and needs no warehouse assignment (not a STAFF_ROLE)', () => {
    expect(HPP_VISIBLE_ROLES).not.toContain(role);
    expect(STAFF_ROLES).not.toContain(role);
  });
});

describe('integration-requester: integrationScope() hook is deny-by-default', () => {
  const run = (r, method, url) => integrationScope({ userContext: { userId: 40, role: r }, method, url });

  it('lets it reach item-requests (any method), GET warehouses and GET me', async () => {
    for (const [method, url] of [
      ['GET', '/api/item-requests'],
      ['GET', '/api/item-requests/12'],
      ['POST', '/api/item-requests'],
      ['POST', '/api/item-requests/12/cancel'],
      ['GET', '/api/item-requests?external_ref=PR-1&source=erp'],
      ['GET', '/api/warehouses'],
      ['GET', '/api/warehouses/3'],
      ['GET', '/api/me/access-status']
    ]) {
      await expect(run(role, method, url), `${method} ${url}`).resolves.toBeUndefined();
    }
  });

  it('refuses everything else, reads included', async () => {
    for (const [method, url] of [
      ['GET', '/api/stocks'],
      ['GET', '/api/stocks/export'],
      ['GET', '/api/items'],
      ['GET', '/api/contacts'],
      ['GET', '/api/sales'],
      ['GET', '/api/purchases'],
      ['GET', '/api/invoices'],
      ['GET', '/api/dashboard/profit'],
      ['GET', '/api/cost-summary'],
      ['GET', '/api/activity-logs'],
      ['GET', '/api/notifications'],
      ['POST', '/api/device-tokens'],
      ['POST', '/api/sales'],
      ['POST', '/api/warehouses'],
      ['PUT', '/api/warehouses/3'],
      ['DELETE', '/api/warehouses/3'],
      ['POST', '/api/me/access-status'],
      // a prefix match must be a path segment, not a string prefix
      ['GET', '/api/item-requests-archive'],
      ['GET', '/api/warehouses-secret']
    ]) {
      await expect(run(role, method, url), `${method} ${url}`).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it('is a no-op for every other role, for no identity, and for public paths', async () => {
    for (const other of ['owner', 'admin-bu', 'admin-warehouse', 'staff-gudang', 'kasir-sales', 'integration-readonly']) {
      await expect(run(other, 'GET', '/api/stocks'), other).resolves.toBeUndefined();
    }
    await expect(integrationScope({ userContext: null, method: 'GET', url: '/api/stocks' })).resolves.toBeUndefined();
    await expect(run(role, 'GET', '/health')).resolves.toBeUndefined();
  });
});

describe('integration-requester: sees only the requests it filed', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    notifyStakeholders.mockResolvedValue();
    notifyUsers.mockResolvedValue();
  });

  it('list is forced to requested_by = itself, whatever the query says', async () => {
    repository.findAll.mockResolvedValue([]);
    repository.count.mockResolvedValue(0);

    await service.listItemRequests(db, { requested_by: 7 }, erp);

    expect(repository.findAll).toHaveBeenCalledWith(db, expect.objectContaining({ buIds: [3], requestedBy: 40 }), expect.anything());
  });

  it('other roles keep the shared BU-wide list (no forced filter)', async () => {
    repository.findAll.mockResolvedValue([]);
    repository.count.mockResolvedValue(0);

    await service.listItemRequests(db, {}, { userId: 7, role: 'kasir-sales', buId: 3, buIds: [3] });

    expect(repository.findAll).toHaveBeenCalledWith(db, expect.objectContaining({ requestedBy: null }), expect.anything());
  });

  it("detail of someone else's request is 404 (not 403), its own is returned", async () => {
    repository.findById.mockResolvedValueOnce(row({ requested_by: 7 })).mockResolvedValueOnce(row());

    await expect(service.getItemRequest(db, 1, [3], erp)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getItemRequest(db, 1, [3], erp)).resolves.toMatchObject({ data: { id: 1 } });
  });

  it('detail without a context still behaves as before for the shared view', async () => {
    repository.findById.mockResolvedValue(row({ requested_by: 7 }));
    await expect(service.getItemRequest(db, 1, [3])).resolves.toMatchObject({ data: { id: 1 } });
  });

  it('a retry of ITS OWN external_ref returns the earlier request', async () => {
    repository.findByExternalRef.mockResolvedValue(row({ id: 2, external_ref: 'ERP-1' }));

    const result = await service.createItemRequest(db, { description: 'x', external_ref: 'ERP-1' }, erp);

    expect(result.statusCode).toBe(200);
    expect(result.body.meta).toEqual({ duplicate: true });
  });

  it('an external_ref already used by someone ELSE is 409 and never returns their request', async () => {
    repository.findByExternalRef.mockResolvedValue(row({ id: 2, requested_by: 7, external_ref: 'ERP-1' }));

    await expect(service.createItemRequest(db, { description: 'x', external_ref: 'ERP-1' }, erp)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EXTERNAL_REF_TAKEN'
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('same protection when two POSTs race into the unique key', async () => {
    repository.findByExternalRef.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: 2, requested_by: 7 }));
    repository.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));

    await expect(service.createItemRequest(db, { description: 'x', external_ref: 'ERP-1' }, erp)).rejects.toMatchObject({
      statusCode: 409
    });
  });

  it("cancelling someone else's request is 404, its own OPEN one works", async () => {
    repository.findById.mockResolvedValueOnce(row({ requested_by: 7 }));
    await expect(service.cancelItemRequest(db, 1, {}, erp)).rejects.toMatchObject({ statusCode: 404 });

    repository.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: 'CANCELLED' }));
    repository.updateStatus.mockResolvedValue(true);
    const result = await service.cancelItemRequest(db, 1, {}, erp);
    expect(result.data.status).toBe('CANCELLED');
    expect(repository.updateStatus).toHaveBeenCalledWith(db, 1, expect.objectContaining({ fromStatuses: ['OPEN'] }));
  });

  it('cannot start, fulfil or reject a request: not a handler', async () => {
    repository.findById.mockResolvedValue(row());
    // The route guard stops this earlier (below); the service must not treat it as a handler either.
    expect(can(role, 'item-requests', 'handle')).toBe(false);
  });
});

// Real routes + the real onRequest guards/hook, identity injected the way user-context.js does after a
// JWT check. Every one of these is decided BEFORE validation and the DB, so a stub db is enough.
async function buildApp(userContext) {
  const app = Fastify({ logger: false });
  app.decorate('db', {});
  app.decorate('storage', null);
  app.decorate('config', { IDEMPOTENCY_TTL_HOURS: 24 });
  app.decorateRequest('userContext', null);
  app.addHook('onRequest', async (request) => {
    request.userContext = userContext;
  });
  app.addHook('onRequest', integrationScope); // same order as src/app.js
  await app.register(itemRequestsRoutes, { prefix: '/api/item-requests' });
  await app.register(salesRoutes, { prefix: '/api/sales' });
  await app.register(stocksRoutes, { prefix: '/api/stocks' });
  await app.register(activityLogsRoutes, { prefix: '/api/activity-logs' });
  await app.register(warehousesRoutes, { prefix: '/api/warehouses' });
  await app.ready();
  return app;
}

describe('integration-requester over HTTP', () => {
  it('gets a real 403 on stock, sales, activity logs and on handling a request', async () => {
    const app = await buildApp(erp);

    for (const [method, url] of [
      ['GET', '/api/stocks'],
      ['GET', '/api/activity-logs'],
      ['POST', '/api/sales'],
      ['POST', '/api/warehouses'],
      ['POST', '/api/item-requests/1/status'] // inside the allowed prefix → stopped by the `handle` guard
    ]) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
  });

  it('gets past the role checks on its own endpoints (anything but 403)', async () => {
    const app = await buildApp(erp);

    for (const [method, url] of [
      ['POST', '/api/item-requests'],
      ['POST', '/api/item-requests/1/cancel'],
      ['GET', '/api/item-requests'],
      ['GET', '/api/warehouses']
    ]) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).not.toBe(403);
    }
    await app.close();
  });

  it('an ordinary warehouse role is unaffected: it still reaches stock and sales checks', async () => {
    const app = await buildApp({ userId: 7, role: 'kasir-sales', buId: 3, buIds: [3] });

    const stocks = await app.inject({ method: 'GET', url: '/api/stocks' });
    expect(stocks.statusCode).not.toBe(403);
    const sale = await app.inject({ method: 'POST', url: '/api/sales', payload: {} });
    expect(sale.statusCode).not.toBe(403);
    await app.close();
  });
});
