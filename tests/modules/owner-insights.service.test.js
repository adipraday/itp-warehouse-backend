import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/dashboard/owner-insights.repository.js';
import * as service from '../../src/modules/dashboard/owner-insights.service.js';

vi.mock('../../src/modules/dashboard/owner-insights.repository.js');

const fakeDb = {};

describe('owner-insights.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('resolvePeriod / previousPeriod', () => {
    it('defaults to the 30 days ending on "to"', () => {
      const period = service.resolvePeriod({ to: '2026-10-31' });
      expect(period).toEqual({ from: '2026-10-02', to: '2026-10-31', days: 30 });
    });

    it('rejects from after to', () => {
      expect(() => service.resolvePeriod({ from: '2026-10-10', to: '2026-10-01' })).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'INVALID_DATE_RANGE' })
      );
    });

    it('rejects spans longer than a year', () => {
      expect(() => service.resolvePeriod({ from: '2025-01-01', to: '2026-10-01' })).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'INVALID_DATE_RANGE' })
      );
    });

    it('builds the equal-length window right before the period', () => {
      const period = service.resolvePeriod({ from: '2026-10-08', to: '2026-10-14' }); // 7 days
      expect(service.previousPeriod(period)).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    });
  });

  describe('getBranchComparison', () => {
    function mockBranches() {
      repository.listWarehouses.mockResolvedValue([
        { id: 1, code: 'WH-1', name: 'Pusat', bu_id: 10 },
        { id: 2, code: 'WH-2', name: 'Cabang', bu_id: 10 },
        { id: 3, code: 'WH-3', name: 'Sepi', bu_id: 11 }
      ]);
      repository.salesByWarehouse
        // current period
        .mockResolvedValueOnce(
          new Map([
            [1, { sales_count: 4, sales_total: '1000000.00' }],
            [2, { sales_count: 9, sales_total: '3000000.00' }]
          ])
        )
        // previous period
        .mockResolvedValueOnce(new Map([[1, { sales_count: 2, sales_total: '800000.00' }]]));
      repository.profitByWarehouse.mockResolvedValue(
        new Map([
          [1, { revenue: '900000.00', cogs: '600000.00' }],
          [2, { revenue: '2700000.00', cogs: '2000000.00' }]
        ])
      );
      repository.stockHealthByWarehouse.mockResolvedValue(
        new Map([[2, { low_stock_count: 3, out_of_stock_count: 1 }]])
      );
      repository.stockValueByWarehouse.mockResolvedValue(new Map([[1, { stock_value: '5000000.00' }]]));
    }

    it('ranks branches by sales, computes margin/growth, and keeps quiet branches as zero rows', async () => {
      mockBranches();

      const { data } = await service.getBranchComparison(fakeDb, { from: '2026-10-01', to: '2026-10-30' }, [10, 11]);

      expect(data.branches.map((b) => b.warehouse_id)).toEqual([2, 1, 3]);
      const [best, mid, quiet] = data.branches;
      expect(best).toMatchObject({
        sales_total: '3000000.00',
        sales_count: 9,
        gross_profit: '700000.00',
        gross_margin_pct: 25.93,
        low_stock_count: 3,
        out_of_stock_count: 1,
        sales_growth_pct: null // no sales in the previous period → no baseline
      });
      expect(mid).toMatchObject({ sales_growth_pct: 25, gross_margin_pct: 33.33, stock_value: '5000000.00' });
      expect(quiet).toMatchObject({ sales_total: '0.00', sales_count: 0, gross_margin_pct: 0 });
    });

    it('totals every branch and compares against the previous period', async () => {
      mockBranches();

      const { data } = await service.getBranchComparison(fakeDb, { from: '2026-10-01', to: '2026-10-30' });

      expect(data.totals).toMatchObject({
        sales_count: 13,
        sales_total: '4000000.00',
        previous_sales_total: '800000.00',
        sales_growth_pct: 400,
        revenue: '3600000.00',
        gross_profit: '1000000.00',
        gross_margin_pct: 27.78,
        low_stock_count: 3,
        out_of_stock_count: 1
      });
      expect(data.period).toEqual({
        from: '2026-10-01',
        to: '2026-10-30',
        previous_from: '2026-09-01',
        previous_to: '2026-09-30'
      });
    });

    it('passes the caller scope through to every query', async () => {
      mockBranches();

      await service.getBranchComparison(fakeDb, { from: '2026-10-01', to: '2026-10-30' }, [10], null);

      expect(repository.listWarehouses).toHaveBeenCalledWith(fakeDb, {
        buIds: [10],
        assignedWarehouseIds: null,
        warehouseId: null
      });
      expect(repository.stockHealthByWarehouse).toHaveBeenCalledWith(fakeDb, {
        buIds: [10],
        assignedWarehouseIds: null
      });
    });
  });

  describe('getCashVariance', () => {
    it('sums shortage and overage, ranks warehouses by shortage, and reports overdue registers', async () => {
      repository.cashVarianceByWarehouse.mockResolvedValue([
        { warehouse_id: 1, sessions_closed: 10, sessions_with_variance: 1, shortage: '5000.00', overage: '0.00' },
        { warehouse_id: 2, sessions_closed: 8, sessions_with_variance: 3, shortage: '150000.00', overage: '20000.00' }
      ]);
      repository.cashVarianceSessions.mockResolvedValue([
        {
          id: 77,
          warehouse_id: 2,
          user_id: 9,
          opened_at: 'a',
          closed_at: 'b',
          opening_amount: '100000',
          expected_cash_amount: '500000',
          closing_amount: '400000',
          cash_difference: '-100000',
          notes: null
        }
      ]);
      repository.overdueOpenSessions.mockResolvedValue([
        { id: 80, warehouse_id: 1, user_id: 4, opened_at: 'x', opening_amount: '50000' }
      ]);

      const { data } = await service.getCashVariance(fakeDb, { from: '2026-10-01', to: '2026-10-30' }, [10]);

      expect(data.by_warehouse.map((row) => row.warehouse_id)).toEqual([2, 1]);
      expect(data.by_warehouse[0]).toMatchObject({ shortage: '150000.00', overage: '20000.00', net: '-130000.00' });
      expect(data.summary).toEqual({
        sessions_closed: 18,
        sessions_with_variance: 4,
        total_shortage: '155000.00',
        total_overage: '20000.00',
        net_difference: '-135000.00',
        overdue_open_count: 1
      });
      expect(data.sessions[0]).toMatchObject({ id: 77, cash_difference: '-100000.00', closing_amount: '400000.00' });
      expect(data.overdue_open_sessions[0]).toMatchObject({ id: 80, opening_amount: '50000.00' });
    });

    it('uses the one-cent default threshold and a 50-row limit unless overridden', async () => {
      repository.cashVarianceByWarehouse.mockResolvedValue([]);
      repository.cashVarianceSessions.mockResolvedValue([]);
      repository.overdueOpenSessions.mockResolvedValue([]);

      await service.getCashVariance(fakeDb, { from: '2026-10-01', to: '2026-10-30' });
      expect(repository.cashVarianceSessions).toHaveBeenCalledWith(
        fakeDb,
        expect.objectContaining({ minAbs: 0.01, limit: 50 })
      );

      await service.getCashVariance(fakeDb, {
        from: '2026-10-01',
        to: '2026-10-30',
        min_abs_difference: 10000,
        limit: 5,
        warehouse_id: 2
      });
      expect(repository.cashVarianceSessions).toHaveBeenLastCalledWith(
        fakeDb,
        expect.objectContaining({ minAbs: 10000, limit: 5, warehouseId: 2 })
      );
    });
  });
});
