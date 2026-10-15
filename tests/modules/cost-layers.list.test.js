import { describe, it, expect, vi } from 'vitest';
import * as repository from '../../src/modules/inventory/costing/cost-layers.repository.js';

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

describe('cost layer list carries the item behind item_id', () => {
  it('selects the SKU and name through subqueries, without ambiguous columns', async () => {
    const db = fakeDb([{ id: 1, item_id: 5, sku: 'A-1', item_name: 'Adaptor' }]);
    const rows = await repository.findAll(db, { warehouseId: 3, itemId: 5, remainingOnly: true }, { limit: 20, offset: 0 });

    const { sql, params } = db.calls[0];
    expect(sql).toContain('AS sku');
    expect(sql).toContain('AS item_name');
    expect(sql).toContain('i.id = inventory_cost_layers.item_id');
    // The filter still uses plain column names, which would be ambiguous if items were JOINed in.
    expect(sql).not.toMatch(/JOIN\s+items/i);
    expect(sql).toContain('warehouse_id = ?');
    expect(params.slice(0, 2)).toEqual([3, 5]);
    expect(rows[0]).toMatchObject({ sku: 'A-1', item_name: 'Adaptor' });
  });

  it('the single read exposes the same fields', async () => {
    const db = fakeDb([{ id: 1 }]);
    await repository.findById(db, 1);
    expect(db.calls[0].sql).toContain('AS item_name');
  });
});
