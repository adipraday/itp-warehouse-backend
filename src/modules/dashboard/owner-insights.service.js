import { BadRequestError } from '../../shared/errors/app-error.js';
import { businessDate } from '../../shared/utils/business-time.js';
import * as repository from './owner-insights.repository.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 366;
// Same threshold the "Selisih Kas" push notification uses (cash-sessions.service.js): anything
// below one cent is rounding noise, not a variance worth surfacing.
const DEFAULT_MIN_CASH_DIFFERENCE = 0.01;
const OVERDUE_OPEN_HOURS = 24;

function toDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

// "Today" is the WIB business day, not the server's UTC date (a day behind from 00:00 to 07:00 WIB).
function today() {
  return businessDate();
}

// Resolves the reporting window. Default is the last 30 days ending today; `from`/`to` may be
// given independently. The span is capped so a careless request can't scan years of invoices.
export function resolvePeriod({ from, to } = {}) {
  const end = to ?? today();
  const start = from ?? toIso(new Date(toDate(end).getTime() - (DEFAULT_PERIOD_DAYS - 1) * DAY_MS));
  const days = Math.round((toDate(end) - toDate(start)) / DAY_MS) + 1;
  if (days < 1) {
    throw new BadRequestError('INVALID_DATE_RANGE', '"from" must not be after "to"');
  }
  if (days > MAX_PERIOD_DAYS) {
    throw new BadRequestError('INVALID_DATE_RANGE', `Date range is limited to ${MAX_PERIOD_DAYS} days`);
  }
  return { from: start, to: end, days };
}

// The window of equal length immediately before [from, to], used for the growth comparison.
export function previousPeriod({ from, days }) {
  const prevTo = toIso(new Date(toDate(from).getTime() - DAY_MS));
  const prevFrom = toIso(new Date(toDate(from).getTime() - days * DAY_MS));
  return { from: prevFrom, to: prevTo };
}

function money(value) {
  return Number(value ?? 0).toFixed(2);
}

function growthPct(current, previous) {
  const prev = Number(previous ?? 0);
  if (prev <= 0) return null; // no baseline to compare against
  return Number((((Number(current ?? 0) - prev) / prev) * 100).toFixed(2));
}

// One row per warehouse the caller may see: sales, margin, growth vs the previous period and a
// stock-health snapshot — what an owner needs to rank branches side by side.
export async function getBranchComparison(db, query, buIds = null, assignedWarehouseIds = null) {
  const period = resolvePeriod(query);
  const prev = previousPeriod(period);
  const scope = { buIds, assignedWarehouseIds };

  const [warehouses, sales, profit, prevSales, health, stockValue] = await Promise.all([
    repository.listWarehouses(db, { ...scope, warehouseId: null }),
    repository.salesByWarehouse(db, { from: period.from, to: period.to, ...scope }),
    repository.profitByWarehouse(db, { from: period.from, to: period.to, ...scope }),
    repository.salesByWarehouse(db, { from: prev.from, to: prev.to, ...scope }),
    repository.stockHealthByWarehouse(db, scope),
    repository.stockValueByWarehouse(db, scope)
  ]);

  const branches = warehouses.map((warehouse) => {
    const id = Number(warehouse.id);
    const revenue = Number(profit.get(id)?.revenue ?? 0);
    const cogs = Number(profit.get(id)?.cogs ?? 0);
    const grossProfit = revenue - cogs;
    return {
      warehouse_id: id,
      code: warehouse.code,
      name: warehouse.name,
      bu_id: warehouse.bu_id ?? null,
      sales_count: Number(sales.get(id)?.sales_count ?? 0),
      sales_total: money(sales.get(id)?.sales_total),
      previous_sales_total: money(prevSales.get(id)?.sales_total),
      sales_growth_pct: growthPct(sales.get(id)?.sales_total, prevSales.get(id)?.sales_total),
      revenue: money(revenue),
      cogs: money(cogs),
      gross_profit: money(grossProfit),
      gross_margin_pct: revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : 0,
      stock_value: money(stockValue.get(id)?.stock_value),
      low_stock_count: Number(health.get(id)?.low_stock_count ?? 0),
      out_of_stock_count: Number(health.get(id)?.out_of_stock_count ?? 0)
    };
  });

  // Best-selling branch first; the client may re-sort by any column.
  branches.sort((a, b) => Number(b.sales_total) - Number(a.sales_total) || a.warehouse_id - b.warehouse_id);

  const sum = (key) => branches.reduce((total, row) => total + Number(row[key]), 0);
  const totalRevenue = sum('revenue');
  const totalProfit = sum('gross_profit');
  const totalSales = sum('sales_total');
  const totalPrevSales = sum('previous_sales_total');

  return {
    data: {
      period: { from: period.from, to: period.to, previous_from: prev.from, previous_to: prev.to },
      totals: {
        sales_count: sum('sales_count'),
        sales_total: money(totalSales),
        previous_sales_total: money(totalPrevSales),
        sales_growth_pct: growthPct(totalSales, totalPrevSales),
        revenue: money(totalRevenue),
        gross_profit: money(totalProfit),
        gross_margin_pct: totalRevenue > 0 ? Number(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0,
        stock_value: money(sum('stock_value')),
        low_stock_count: sum('low_stock_count'),
        out_of_stock_count: sum('out_of_stock_count')
      },
      branches
    }
  };
}

// Cash reconciliation across branches: totals, a per-warehouse breakdown, the worst individual
// sessions, and registers that were left open for too long.
export async function getCashVariance(db, query, buIds = null, assignedWarehouseIds = null) {
  const period = resolvePeriod(query);
  const minAbs = query.min_abs_difference ?? DEFAULT_MIN_CASH_DIFFERENCE;
  const limit = query.limit ?? 50;
  const warehouseId = query.warehouse_id ?? null;
  const filter = { from: period.from, to: period.to, warehouseId, buIds, assignedWarehouseIds };

  const [byWarehouseRows, sessions, overdue] = await Promise.all([
    repository.cashVarianceByWarehouse(db, { minAbs, ...filter }),
    repository.cashVarianceSessions(db, { minAbs, limit, ...filter }),
    repository.overdueOpenSessions(db, {
      hours: OVERDUE_OPEN_HOURS,
      limit: 20,
      warehouseId,
      buIds,
      assignedWarehouseIds
    })
  ]);

  const byWarehouse = byWarehouseRows
    .map((row) => ({
      warehouse_id: Number(row.warehouse_id),
      sessions_closed: Number(row.sessions_closed),
      sessions_with_variance: Number(row.sessions_with_variance),
      shortage: money(row.shortage),
      overage: money(row.overage),
      net: money(Number(row.overage) - Number(row.shortage))
    }))
    .sort((a, b) => Number(b.shortage) - Number(a.shortage) || a.warehouse_id - b.warehouse_id);

  const sumBy = (key) => byWarehouse.reduce((total, row) => total + Number(row[key]), 0);
  const shortage = sumBy('shortage');
  const overage = sumBy('overage');

  return {
    data: {
      period: { from: period.from, to: period.to },
      min_abs_difference: money(minAbs),
      summary: {
        sessions_closed: sumBy('sessions_closed'),
        sessions_with_variance: sumBy('sessions_with_variance'),
        total_shortage: money(shortage),
        total_overage: money(overage),
        net_difference: money(overage - shortage),
        overdue_open_count: overdue.length
      },
      by_warehouse: byWarehouse,
      sessions: sessions.map((row) => ({
        id: row.id,
        warehouse_id: Number(row.warehouse_id),
        user_id: Number(row.user_id),
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        opening_amount: money(row.opening_amount),
        expected_cash_amount: money(row.expected_cash_amount),
        closing_amount: money(row.closing_amount),
        cash_difference: money(row.cash_difference),
        notes: row.notes ?? null
      })),
      overdue_open_sessions: overdue.map((row) => ({
        id: row.id,
        warehouse_id: Number(row.warehouse_id),
        user_id: Number(row.user_id),
        opened_at: row.opened_at,
        opening_amount: money(row.opening_amount)
      }))
    }
  };
}
