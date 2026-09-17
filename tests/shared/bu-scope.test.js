import { describe, it, expect, vi } from 'vitest';
import { buScope } from '../../src/shared/auth/bu-scope.js';

// Fake db.execute: branches on the SQL text so each test only has to describe
// what rows exist, not how buScope phrases each lookup.
function makeDb({ warehouses = [], invoices = [], docs = {} } = {}) {
  const execute = vi.fn(async (sql, params) => {
    if (sql.includes('FROM warehouses WHERE id IN')) {
      const ids = params.map(Number);
      return [warehouses.filter((w) => ids.includes(w.id))];
    }
    if (sql.includes('FROM invoices WHERE id = ?')) {
      const invoice = invoices.find((i) => i.id === params[0]);
      return [invoice ? [{ w: invoice.warehouse_id }] : []];
    }
    // Per-resource :id lookup (DOC_WAREHOUSE_SQL) — keyed by table name mentioned in the SQL.
    for (const [table, rows] of Object.entries(docs)) {
      if (sql.includes(`FROM ${table}`)) {
        const row = rows.find((r) => r.id === params[0]);
        return [row ? [row.result] : []];
      }
    }
    throw new Error(`unexpected query in test double: ${sql}`);
  });
  return { execute };
}

function makeRequest({ userContext, body = {}, query = {}, params = {}, db }) {
  return { userContext, body, query, params, server: { db } };
}

describe('buScope()', () => {
  it('is a no-op with no identity (nothing to compare against)', async () => {
    const db = makeDb();
    const hook = buScope('sales');
    await hook(makeRequest({ userContext: null, body: { warehouse_id: 22 }, db }));
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('is a no-op for super-admin (buIds === null)', async () => {
    const db = makeDb();
    const hook = buScope('sales');
    await hook(
      makeRequest({ userContext: { userId: 1, role: 'super-admin', buIds: null }, body: { warehouse_id: 22 }, db })
    );
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('is a no-op when no warehouse can be resolved from body/query/params', async () => {
    const db = makeDb();
    const hook = buScope('sales');
    await hook(makeRequest({ userContext: { userId: 1, role: 'kasir-sales', buIds: [11] }, db }));
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('passes when the body warehouse_id belongs to the caller\'s BU', async () => {
    const db = makeDb({ warehouses: [{ id: 22, bu_id: 11 }] });
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'staff-gudang', buIds: [11] },
          body: { warehouse_id: 22 },
          db
        })
      )
    ).resolves.toBeUndefined();
  });

  it('throws 403 when the body warehouse_id belongs to a different BU', async () => {
    const db = makeDb({ warehouses: [{ id: 23, bu_id: 12 }] });
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'staff-gudang', buIds: [11] },
          body: { warehouse_id: 23 },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('checks query.warehouse_id the same way as body (list endpoints)', async () => {
    const db = makeDb({ warehouses: [{ id: 23, bu_id: 12 }] });
    const hook = buScope('sales');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'kasir-sales', buIds: [11] },
          query: { warehouse_id: '23' },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('does not throw for a warehouse id that does not exist (lets the handler 404)', async () => {
    const db = makeDb({ warehouses: [] });
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'staff-gudang', buIds: [11] },
          body: { warehouse_id: 999 },
          db
        })
      )
    ).resolves.toBeUndefined();
  });

  it('resolves the target warehouse for a payment via its invoice_id', async () => {
    const db = makeDb({
      invoices: [{ id: 5, warehouse_id: 23 }],
      warehouses: [{ id: 23, bu_id: 12 }]
    });
    const hook = buScope('payments');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'finance', buIds: [11] },
          body: { invoice_id: 5, amount: 100 },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('for the "warehouses" resource, params.id IS the target warehouse', async () => {
    const db = makeDb({ warehouses: [{ id: 23, bu_id: 12 }] });
    const hook = buScope('warehouses');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'admin-bu', buIds: [11] },
          params: { id: '23' },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('looks up a document\'s warehouse via DOC_WAREHOUSE_SQL for params.id on other resources', async () => {
    // sales' DOC_WAREHOUSE_SQL and the payments invoice_id lookup share the same
    // "FROM invoices WHERE id = ?" shape, so this reuses the `invoices` fixture.
    const db = makeDb({
      invoices: [{ id: 77, warehouse_id: 23 }],
      warehouses: [{ id: 23, bu_id: 12 }]
    });
    const hook = buScope('sales');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'kasir-sales', buIds: [11] },
          params: { id: '77' },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a stock-transfer whose destination warehouse is in a different BU', async () => {
    const db = makeDb({
      docs: { stock_transfers: [{ id: 9, result: { w1: 22, w2: 23 } }] },
      warehouses: [
        { id: 22, bu_id: 11 },
        { id: 23, bu_id: 12 }
      ]
    });
    const hook = buScope('stock-transfers');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'staff-gudang', buIds: [11] },
          params: { id: '9' },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('passes a stock-transfer whose source and destination are both in the caller\'s BU', async () => {
    const db = makeDb({
      docs: { stock_transfers: [{ id: 10, result: { w1: 22, w2: 24 } }] },
      warehouses: [
        { id: 22, bu_id: 11 },
        { id: 24, bu_id: 11 }
      ]
    });
    const hook = buScope('stock-transfers');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'staff-gudang', buIds: [11] },
          params: { id: '10' },
          db
        })
      )
    ).resolves.toBeUndefined();
  });

  it('passes when the warehouse belongs to the SECOND of several allowed business units (grant/owner)', async () => {
    const db = makeDb({ warehouses: [{ id: 23, bu_id: 12 }] });
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'admin-bu', buIds: [11, 12] },
          body: { warehouse_id: 23 },
          db
        })
      )
    ).resolves.toBeUndefined();
  });

  it('rejects everything when buIds is an empty array (no BU access at all)', async () => {
    const db = makeDb({ warehouses: [{ id: 22, bu_id: 11 }] });
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'admin-bu', buIds: [] },
          body: { warehouse_id: 22 },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a body warehouse_id in the caller\'s BU but not in their assignedWarehouseIds', async () => {
    const db = makeDb({ warehouses: [{ id: 22, bu_id: 11 }] }); // warehouse 22 IS in BU 11...
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          // ...but this staff-gudang is only assigned to warehouse 24 (Cabang), not 22 (Pusat).
          userContext: { userId: 1, role: 'staff-gudang', buIds: [11], assignedWarehouseIds: [24] },
          body: { warehouse_id: 22 },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('passes a body warehouse_id that is both in the caller\'s BU and their assignedWarehouseIds', async () => {
    const db = makeDb({ warehouses: [{ id: 24, bu_id: 11 }] });
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'staff-gudang', buIds: [11], assignedWarehouseIds: [24] },
          body: { warehouse_id: 24 },
          db
        })
      )
    ).resolves.toBeUndefined();
  });

  it('is not a no-op for super-admin when assignedWarehouseIds is somehow set (defensive — checks it independently of buIds)', async () => {
    const db = makeDb({ warehouses: [{ id: 22, bu_id: 11 }] });
    const hook = buScope('inbounds');
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'super-admin', buIds: null, assignedWarehouseIds: [24] },
          body: { warehouse_id: 22 },
          db
        })
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('is a no-op for a resource with a params.id but no DOC_WAREHOUSE_SQL entry', async () => {
    const db = makeDb();
    const hook = buScope('items'); // not in DOC_WAREHOUSE_SQL
    await expect(
      hook(
        makeRequest({
          userContext: { userId: 1, role: 'purchasing', buIds: [11] },
          params: { id: '1' },
          db
        })
      )
    ).resolves.toBeUndefined();
    expect(db.execute).not.toHaveBeenCalled();
  });
});
