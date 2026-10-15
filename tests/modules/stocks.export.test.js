import { describe, it, expect, vi } from 'vitest';
import * as repository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as service from '../../src/modules/inventory/stocks/stocks.service.js';

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

describe('stocks export query', () => {
  it('has no pagination and keeps the soft-delete filter', async () => {
    const db = fakeDb();
    await repository.findAllForExport(db, { status: 'all' });
    const { sql } = db.calls[0];
    expect(sql).toContain('i.deleted_at IS NULL');
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('s.quantity >');
    expect(sql).not.toContain('s.quantity =');
  });

  it('low = above zero and at/below min_stock, same as the low-stock endpoint', async () => {
    const db = fakeDb();
    await repository.findAllForExport(db, { status: 'low' });
    expect(db.calls[0].sql).toContain('s.quantity > 0 AND s.quantity <= i.min_stock');
  });

  it('out = exactly zero, same as the out-of-stock endpoint', async () => {
    const db = fakeDb();
    await repository.findAllForExport(db, { status: 'out' });
    expect(db.calls[0].sql).toContain('s.quantity = 0');
  });

  it('applies the warehouse, BU and assignment filters', async () => {
    const db = fakeDb();
    await repository.findAllForExport(db, { status: 'all', warehouseId: 7, buIds: [11], assignedWarehouseIds: [7] });
    const { sql, params } = db.calls[0];
    expect(sql).toContain('s.warehouse_id = ?');
    expect(params).toEqual([7, 11, 7]);
  });
});

describe('stocks export service', () => {
  it('labels each row Normal / Low Stock / Out of Stock', () => {
    expect(service.stockStatusLabel({ quantity: 0, min_stock: 5 })).toBe('Out of Stock');
    expect(service.stockStatusLabel({ quantity: 3, min_stock: 5 })).toBe('Low Stock');
    expect(service.stockStatusLabel({ quantity: 5, min_stock: 5 })).toBe('Low Stock');
    expect(service.stockStatusLabel({ quantity: 6, min_stock: 5 })).toBe('Normal');
    expect(service.stockStatusLabel({ quantity: 4, min_stock: 0 })).toBe('Normal');
  });

  it('produces a CSV with a header and one line per stock row', async () => {
    const db = fakeDb([
      { warehouse_code: 'WH1', warehouse_name: 'Pusat', sku: 'A1', item_name: 'Kopi, Susu', unit: 'pcs', quantity: 2, min_stock: 5 }
    ]);
    const file = await service.exportStocks(db, { status: 'low', format: 'csv' });
    expect(file.extension).toBe('csv');
    const lines = file.buffer.toString('utf8').trim().split('\n');
    expect(lines[0]).toBe('warehouse_code,warehouse_name,sku,item_name,unit,quantity,min_stock,status');
    expect(lines[1]).toBe('WH1,Pusat,A1,"Kopi, Susu",pcs,2,5,Low Stock');
  });

  it('can produce a real PDF with the report data', async () => {
    const db = fakeDb([
      { warehouse_code: 'WH1', warehouse_name: 'Pusat', sku: 'A1', item_name: 'Kopi', unit: 'pcs', quantity: 0, min_stock: 5 }
    ]);
    const file = await service.exportStocks(db, { status: 'out', format: 'pdf' });
    expect(file.extension).toBe('pdf');
    expect(file.contentType).toBe('application/pdf');
    expect(file.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still produces a valid PDF with no rows', async () => {
    const file = await service.exportStocks(fakeDb([]), { format: 'pdf' });
    expect(file.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('paginates a long report instead of overflowing one page', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      warehouse_code: 'WH1', warehouse_name: 'Pusat', sku: `S${i}`, item_name: `Item ${i}`, unit: 'pcs', quantity: i, min_stock: 5
    }));
    const file = await service.exportStocks(fakeDb(many), { format: 'pdf' });
    const pageCount = Number(/\/Count (\d+)/.exec(file.buffer.toString('latin1'))?.[1] ?? 0);
    expect(pageCount).toBeGreaterThan(1);
  });

  it('can produce an xlsx', async () => {
    const file = await service.exportStocks(fakeDb(), { format: 'xlsx' });
    expect(file.extension).toBe('xlsx');
    expect(file.buffer.length).toBeGreaterThan(0);
  });
});
