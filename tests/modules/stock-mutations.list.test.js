import { describe, it, expect, vi } from 'vitest';
import * as repository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    execute: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      return [rows, []];
    })
  };
}

describe('stock mutation list carries the item and warehouse behind the ids', () => {
  it('joins item and warehouse names and qualifies every filter column with the mutation alias', async () => {
    const db = fakeDb([{ id: 1, item_id: 5, item_sku: 'A-1', item_name: 'Adaptor', warehouse_name: 'Gudang A' }]);
    const query = {
      warehouseId: 3,
      itemId: 5,
      type: 'IN',
      direction: 'IN',
      sourceType: 'INVENTORY_TRANSACTION',
      sourceId: 9,
      from: '2026-10-01',
      to: '2026-10-31',
      buIds: [1],
      assignedWarehouseIds: [3]
    };
    const rows = await repository.findAll(db, query, { limit: 20, offset: 0 });

    const { sql, params } = db.calls[0];
    expect(sql).toContain('i.name AS item_name');
    expect(sql).toContain('i.sku AS item_sku');
    expect(sql).toContain('w.name AS warehouse_name');
    // items and warehouses both have id/bu_id/name columns, so nothing may be left unqualified.
    for (const column of ['warehouse_id', 'item_id', 'type', 'direction', 'source_type', 'source_id', 'occurred_at']) {
      expect(sql).not.toMatch(new RegExp(`(?<![.\\w])${column} (=|>=|<=|IN)`));
    }
    expect(sql).toContain('m.warehouse_id IN (SELECT id FROM warehouses WHERE bu_id IN (?))');
    expect(params).toEqual([3, 5, 'IN', 'IN', 'INVENTORY_TRANSACTION', 9, '2026-10-01 00:00:00', '2026-10-31 23:59:59', 1, 3, 20, 0]);
    expect(rows[0]).toMatchObject({ item_sku: 'A-1', item_name: 'Adaptor', warehouse_name: 'Gudang A' });
  });

  it('count uses the same alias so the filter stays valid without the joins', async () => {
    const db = fakeDb([{ total: 4 }]);
    const total = await repository.count(db, { itemId: 5 });

    expect(total).toBe(4);
    expect(db.calls[0].sql).toContain('FROM stock_mutations m');
    expect(db.calls[0].sql).toContain('m.item_id = ?');
  });

  it('the single read exposes the same fields', async () => {
    const db = fakeDb([{ id: 1 }]);
    await repository.findById(db, 1);
    expect(db.calls[0].sql).toContain('i.name AS item_name');
    expect(db.calls[0].sql).toContain('WHERE m.id = ?');
  });
});
