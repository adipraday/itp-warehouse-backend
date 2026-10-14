import { describe, it, expect, vi } from 'vitest';
import * as repository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as service from '../../src/modules/inventory/stocks/stocks.service.js';

function fakeDb() {
  const calls = [];
  return {
    calls,
    execute: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      return [sql.includes('COUNT(*)') ? [{ total: 0 }] : [], []];
    })
  };
}

describe('stocks list search (q)', () => {
  it('matches the item SKU, name or barcode, and keeps the soft-delete filter', async () => {
    const db = fakeDb();
    await repository.findAll(db, { q: 'kopi', limit: 20, offset: 0 });

    const { sql, params } = db.calls[0];
    expect(sql).toContain('i.deleted_at IS NULL');
    expect(sql).toContain('(i.sku LIKE ? OR i.name LIKE ? OR i.barcode LIKE ?)');
    expect(params.slice(0, 3)).toEqual(['%kopi%', '%kopi%', '%kopi%']);
  });

  it('counts with the same filter so pagination matches the search', async () => {
    const db = fakeDb();
    await repository.count(db, { q: 'kopi', warehouseId: 3 });

    const { sql, params } = db.calls[0];
    expect(sql).toContain('LIKE');
    expect(params).toEqual(['%kopi%', '%kopi%', '%kopi%', 3]);
  });

  it('adds no LIKE clause without a query', async () => {
    const db = fakeDb();
    await repository.findAll(db, { limit: 20, offset: 0 });
    expect(db.calls[0].sql).not.toContain('LIKE');
  });

  it('the service trims q and ignores a blank one', async () => {
    const db = fakeDb();
    await service.listStocks(db, { q: '  kopi  ', page: 1, per_page: 20 });
    expect(db.calls[0].params.slice(0, 3)).toEqual(['%kopi%', '%kopi%', '%kopi%']);

    const blank = fakeDb();
    await service.listStocks(blank, { q: '   ', page: 1, per_page: 20 });
    expect(blank.calls[0].sql).not.toContain('LIKE');
  });
});
