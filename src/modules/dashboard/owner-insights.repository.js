import { buIdsCondition, directBuIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';
import { BUSINESS_UTC_OFFSET, DB_UTC_OFFSET } from '../../shared/utils/business-time.js';

// Owner / multi-branch monitoring queries — read-only, built on the same scoping helpers as the
// rest of the dashboard (BU filter first, then the optional assigned-warehouse narrowing). Every
// query is already restricted to the caller's business units, so an owner only ever aggregates
// the BUs of their own company.

function scopeConditions(warehouseColumn, buIds, assignedWarehouseIds) {
  const conditions = [];
  const params = [];
  const bu = buIdsCondition(warehouseColumn, buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition(warehouseColumn, assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return { conditions, params };
}

// Every warehouse the caller may see (even ones with no activity in the period, so a quiet
// branch still shows up as a row of zeros instead of silently disappearing).
export async function listWarehouses(db, { buIds, assignedWarehouseIds, warehouseId }) {
  const conditions = [];
  const params = [];
  const bu = directBuIdsCondition('bu_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  if (warehouseId) {
    conditions.push('id = ?');
    params.push(warehouseId);
  }
  const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await db.execute(
    `SELECT id, code, name, bu_id FROM warehouses ${clause} ORDER BY bu_id ASC, name ASC, id ASC`,
    params
  );
  return rows;
}

// Completed SALES per warehouse in [from, to]: document count and gross billed total (the same
// "Total Sales" number the main dashboard shows).
export async function salesByWarehouse(db, { from, to, buIds, assignedWarehouseIds }) {
  const scope = scopeConditions('warehouse_id', buIds, assignedWarehouseIds);
  const [rows] = await db.execute(
    `SELECT warehouse_id, COUNT(*) AS sales_count, COALESCE(SUM(total_amount), 0) AS sales_total
     FROM invoices
     WHERE type = 'SALES' AND status = 'COMPLETED' AND invoice_date >= ? AND invoice_date <= ?
       ${scope.conditions.length ? `AND ${scope.conditions.join(' AND ')}` : ''}
     GROUP BY warehouse_id`,
    [from, to, ...scope.params]
  );
  return new Map(rows.map((row) => [Number(row.warehouse_id), row]));
}

// Revenue and COGS per warehouse, summed from line items — the same basis as /dashboard/profit.
export async function profitByWarehouse(db, { from, to, buIds, assignedWarehouseIds }) {
  const scope = scopeConditions('i.warehouse_id', buIds, assignedWarehouseIds);
  const [rows] = await db.execute(
    `SELECT i.warehouse_id, COALESCE(SUM(d.amount), 0) AS revenue, COALESCE(SUM(d.cost_amount), 0) AS cogs
     FROM invoice_details d JOIN invoices i ON i.id = d.invoice_id
     WHERE i.type = 'SALES' AND i.status = 'COMPLETED' AND i.invoice_date >= ? AND i.invoice_date <= ?
       ${scope.conditions.length ? `AND ${scope.conditions.join(' AND ')}` : ''}
     GROUP BY i.warehouse_id`,
    [from, to, ...scope.params]
  );
  return new Map(rows.map((row) => [Number(row.warehouse_id), row]));
}

// Current stock health per warehouse (a snapshot, not period-bound).
export async function stockHealthByWarehouse(db, { buIds, assignedWarehouseIds }) {
  const scope = scopeConditions('s.warehouse_id', buIds, assignedWarehouseIds);
  const [rows] = await db.execute(
    `SELECT s.warehouse_id,
            COALESCE(SUM(CASE WHEN s.quantity > 0 AND s.quantity <= i.min_stock THEN 1 ELSE 0 END), 0) AS low_stock_count,
            COALESCE(SUM(CASE WHEN s.quantity = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count
     FROM stocks s JOIN items i ON i.id = s.item_id
     WHERE i.deleted_at IS NULL ${scope.conditions.length ? `AND ${scope.conditions.join(' AND ')}` : ''}
     GROUP BY s.warehouse_id`,
    scope.params
  );
  return new Map(rows.map((row) => [Number(row.warehouse_id), row]));
}

export async function stockValueByWarehouse(db, { buIds, assignedWarehouseIds }) {
  const scope = scopeConditions('warehouse_id', buIds, assignedWarehouseIds);
  const [rows] = await db.execute(
    `SELECT warehouse_id, COALESCE(SUM(quantity_remaining * unit_cost), 0) AS stock_value
     FROM inventory_cost_layers
     WHERE quantity_remaining > 0 ${scope.conditions.length ? `AND ${scope.conditions.join(' AND ')}` : ''}
     GROUP BY warehouse_id`,
    scope.params
  );
  return new Map(rows.map((row) => [Number(row.warehouse_id), row]));
}

// ---- Cash variance monitoring ----------------------------------------------------------------

// A session belongs to the business day (WIB) it was CLOSED on. closed_at is stored in UTC, so a
// register closed at 06:00 WIB would otherwise count toward the previous day.
const CLOSED_BUSINESS_DAY = `DATE(CONVERT_TZ(closed_at, '${DB_UTC_OFFSET}', '${BUSINESS_UTC_OFFSET}'))`;

function cashFilter({ from, to, warehouseId, buIds, assignedWarehouseIds }) {
  const conditions = ["status = 'CLOSED'", `${CLOSED_BUSINESS_DAY} >= ?`, `${CLOSED_BUSINESS_DAY} <= ?`];
  const params = [from, to];
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
  }
  const scope = scopeConditions('warehouse_id', buIds, assignedWarehouseIds);
  conditions.push(...scope.conditions);
  params.push(...scope.params);
  return { clause: conditions.join(' AND '), params };
}

// Per-warehouse totals over the CLOSED sessions in the period. A "variance" is a closed session
// whose |cash_difference| reaches minAbs; shortage/overage are the summed absolute amounts.
export async function cashVarianceByWarehouse(db, { minAbs, ...filter }) {
  const { clause, params } = cashFilter(filter);
  const [rows] = await db.execute(
    `SELECT warehouse_id,
            COUNT(*) AS sessions_closed,
            COALESCE(SUM(CASE WHEN ABS(cash_difference) >= ? THEN 1 ELSE 0 END), 0) AS sessions_with_variance,
            COALESCE(SUM(CASE WHEN cash_difference <= -? THEN -cash_difference ELSE 0 END), 0) AS shortage,
            COALESCE(SUM(CASE WHEN cash_difference >= ? THEN cash_difference ELSE 0 END), 0) AS overage
     FROM cash_sessions WHERE ${clause}
     GROUP BY warehouse_id`,
    [minAbs, minAbs, minAbs, ...params]
  );
  return rows;
}

// The worst individual sessions first (largest absolute difference).
export async function cashVarianceSessions(db, { minAbs, limit, ...filter }) {
  const { clause, params } = cashFilter(filter);
  const [rows] = await db.execute(
    `SELECT id, warehouse_id, user_id, opened_at, closed_at, opening_amount, expected_cash_amount,
            closing_amount, cash_difference, notes
     FROM cash_sessions
     WHERE ${clause} AND ABS(cash_difference) >= ?
     ORDER BY ABS(cash_difference) DESC, id DESC LIMIT ?`,
    [...params, minAbs, limit]
  );
  return rows;
}

// Registers left open for a long time (a forgotten Tutup Kasir): the cash isn't reconciled yet,
// so these are a risk of their own even though they have no difference to report.
export async function overdueOpenSessions(db, { hours, limit, warehouseId, buIds, assignedWarehouseIds }) {
  const conditions = ["status = 'OPEN'", 'opened_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)'];
  const params = [hours];
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
  }
  const scope = scopeConditions('warehouse_id', buIds, assignedWarehouseIds);
  conditions.push(...scope.conditions);
  params.push(...scope.params);
  const [rows] = await db.execute(
    `SELECT id, warehouse_id, user_id, opened_at, opening_amount
     FROM cash_sessions WHERE ${conditions.join(' AND ')} ORDER BY opened_at ASC LIMIT ?`,
    [...params, limit]
  );
  return rows;
}
