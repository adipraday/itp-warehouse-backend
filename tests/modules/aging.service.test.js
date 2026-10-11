import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/dashboard/aging.repository.js';
import * as service from '../../src/modules/dashboard/aging.service.js';

vi.mock('../../src/modules/dashboard/aging.repository.js');

const db = {};

function row(overrides = {}) {
  return {
    id: 1,
    invoice_number: 'SAL-000001',
    warehouse_id: 3,
    contact_id: 10,
    contact_name: 'Toko Budi',
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    total_amount: '1000000.00',
    paid_amount: '400000.00',
    outstanding: '600000.00',
    days_overdue: 12,
    ...overrides
  };
}

describe('aging.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('asks the repository for the right invoice type per side', async () => {
    repository.findOutstanding.mockResolvedValue([]);

    await service.getAging(db, { side: 'receivable', warehouse_id: 4 }, [1], null);
    expect(repository.findOutstanding).toHaveBeenLastCalledWith(
      db,
      expect.objectContaining({ type: 'SALES', warehouseId: 4, buIds: [1], assignedWarehouseIds: null })
    );

    await service.getAging(db, { side: 'payable' }, null, null);
    expect(repository.findOutstanding).toHaveBeenLastCalledWith(db, expect.objectContaining({ type: 'PURCHASE' }));
  });

  it('puts each invoice in the right aging bucket, including the boundaries', async () => {
    repository.findOutstanding.mockResolvedValue([
      row({ id: 1, outstanding: '100.00', days_overdue: -5 }), // not due yet
      row({ id: 2, outstanding: '200.00', days_overdue: 0 }), // due today = not overdue
      row({ id: 3, outstanding: '300.00', days_overdue: 1 }),
      row({ id: 4, outstanding: '400.00', days_overdue: 30 }),
      row({ id: 5, outstanding: '500.00', days_overdue: 31 }),
      row({ id: 6, outstanding: '600.00', days_overdue: 60 }),
      row({ id: 7, outstanding: '700.00', days_overdue: 61 }),
      row({ id: 8, outstanding: '800.00', days_overdue: 90 }),
      row({ id: 9, outstanding: '900.00', days_overdue: 91 })
    ]);

    const { data } = await service.getAging(db, { side: 'receivable' });

    const byKey = Object.fromEntries(data.buckets.map((bucket) => [bucket.key, bucket]));
    expect(byKey.current).toMatchObject({ count: 2, amount: '300.00' });
    expect(byKey.d1_30).toMatchObject({ count: 2, amount: '700.00' });
    expect(byKey.d31_60).toMatchObject({ count: 2, amount: '1100.00' });
    expect(byKey.d61_90).toMatchObject({ count: 2, amount: '1500.00' });
    expect(byKey.d90_plus).toMatchObject({ count: 1, amount: '900.00' });
    expect(data.total_outstanding).toBe('4500.00');
    expect(data.invoice_count).toBe(9);
    expect(data.overdue_total).toBe('4200.00'); // everything past due
    expect(data.overdue_count).toBe(7);
  });

  it('ranks counterparties by balance, keeps walk-in invoices together, and splits by warehouse', async () => {
    repository.findOutstanding.mockResolvedValue([
      row({ id: 1, contact_id: 10, contact_name: 'Toko Budi', outstanding: '100.00', days_overdue: 5, warehouse_id: 3 }),
      row({ id: 2, contact_id: 10, contact_name: 'Toko Budi', outstanding: '150.00', days_overdue: 40, warehouse_id: 4 }),
      row({ id: 3, contact_id: 11, contact_name: 'CV Maju', outstanding: '500.00', days_overdue: 2, warehouse_id: 3 }),
      row({ id: 4, contact_id: null, contact_name: null, outstanding: '20.00', days_overdue: 1, warehouse_id: 3 }),
      row({ id: 5, contact_id: null, contact_name: null, outstanding: '30.00', days_overdue: 9, warehouse_id: 3 })
    ]);

    const { data } = await service.getAging(db, { side: 'receivable' });

    expect(data.by_contact.map((c) => [c.contact_name, c.amount, c.count])).toEqual([
      ['CV Maju', '500.00', 1],
      ['Toko Budi', '250.00', 2],
      [null, '50.00', 2]
    ]);
    expect(data.by_contact[1].oldest_days_overdue).toBe(40);
    expect(data.by_warehouse).toEqual([
      { warehouse_id: 3, count: 4, amount: '650.00' },
      { warehouse_id: 4, count: 1, amount: '150.00' }
    ]);
  });

  it('caps the invoice list but keeps totals over every invoice', async () => {
    repository.findOutstanding.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => row({ id: index + 1, outstanding: '10.00', days_overdue: 10 - index }))
    );

    const { data } = await service.getAging(db, { side: 'payable', limit: 2 });

    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({ invoice_id: 1, outstanding: '10.00', days_overdue: 10 });
    expect(data.truncated).toBe(true);
    expect(data.invoice_count).toBe(5);
    expect(data.total_outstanding).toBe('50.00');
  });

  it('returns zeros for an empty ledger', async () => {
    repository.findOutstanding.mockResolvedValue([]);

    const { data } = await service.getAging(db, { side: 'receivable' });

    expect(data).toMatchObject({ total_outstanding: '0.00', invoice_count: 0, overdue_total: '0.00', truncated: false });
    expect(data.buckets.every((bucket) => bucket.count === 0 && bucket.amount === '0.00')).toBe(true);
    expect(data.items).toEqual([]);
  });
});
