import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

export async function stockSummary(db, warehouseId, buIds = null, assignedWarehouseIds = null) {
  const conditions = [];
  const params = [];
  if (warehouseId) {
    conditions.push('s.warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('s.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('s.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [stockRows] = await db.execute(
    `SELECT COUNT(*) AS total_items, COALESCE(SUM(s.quantity), 0) AS total_quantity,
            COALESCE(SUM(CASE WHEN s.quantity > 0 AND s.quantity <= i.min_stock THEN 1 ELSE 0 END), 0) AS low_stock_count,
            COALESCE(SUM(CASE WHEN s.quantity = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count
     FROM stocks s JOIN items i ON i.id = s.item_id ${clause}`,
    params
  );

  const layerConditions = ['quantity_remaining > 0'];
  const layerParams = [];
  if (warehouseId) {
    layerConditions.push('warehouse_id = ?');
    layerParams.push(warehouseId);
  }
  const layerBu = buIdsCondition('warehouse_id', buIds);
  if (layerBu) {
    layerConditions.push(layerBu.clause);
    layerParams.push(...layerBu.params);
  }
  const layerWh = assignedWarehouseCondition('warehouse_id', assignedWarehouseIds);
  if (layerWh) {
    layerConditions.push(layerWh.clause);
    layerParams.push(...layerWh.params);
  }
  const [valueRows] = await db.execute(
    `SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) AS total_value
     FROM inventory_cost_layers WHERE ${layerConditions.join(' AND ')}`,
    layerParams
  );

  const stockRow = stockRows[0];
  return {
    total_items: Number(stockRow.total_items ?? 0),
    total_quantity: Number(stockRow.total_quantity ?? 0),
    total_value: Number(valueRows[0].total_value ?? 0).toFixed(2),
    low_stock_count: Number(stockRow.low_stock_count ?? 0),
    out_of_stock_count: Number(stockRow.out_of_stock_count ?? 0)
  };
}

function dateRangeConditions(column, { from, to }) {
  const conditions = [];
  const params = [];
  if (from) {
    conditions.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    conditions.push(`${column} <= ?`);
    params.push(to);
  }
  return { conditions, params };
}

export async function invoiceSummary(db, { type, warehouseId, from, to, buIds, assignedWarehouseIds }) {
  const conditions = ['type = ?', "status = 'COMPLETED'"];
  const params = [type];
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  const dateRange = dateRangeConditions('invoice_date', { from, to });
  conditions.push(...dateRange.conditions);
  params.push(...dateRange.params);

  const [rows] = await db.execute(
    `SELECT COUNT(*) AS count, COALESCE(SUM(subtotal), 0) AS subtotal, COALESCE(SUM(tax), 0) AS tax,
            COALESCE(SUM(total_amount), 0) AS total_amount
     FROM invoices WHERE ${conditions.join(' AND ')}`,
    params
  );
  const row = rows[0];
  return {
    count: Number(row.count ?? 0),
    subtotal: Number(row.subtotal ?? 0).toFixed(2),
    tax: Number(row.tax ?? 0).toFixed(2),
    total_amount: Number(row.total_amount ?? 0).toFixed(2)
  };
}

export async function salesTrend(db, { warehouseId, from, to, buIds, assignedWarehouseIds }) {
  const conditions = ["type = 'SALES'", "status = 'COMPLETED'"];
  const params = [];
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  const dateRange = dateRangeConditions('invoice_date', { from, to });
  conditions.push(...dateRange.conditions);
  params.push(...dateRange.params);

  const [rows] = await db.execute(
    `SELECT invoice_date AS date, COUNT(*) AS count, COALESCE(SUM(subtotal), 0) AS subtotal,
            COALESCE(SUM(tax), 0) AS tax, COALESCE(SUM(total_amount), 0) AS total_amount
     FROM invoices WHERE ${conditions.join(' AND ')}
     GROUP BY invoice_date ORDER BY invoice_date ASC`,
    params
  );
  return rows.map((row) => ({
    date: row.date,
    count: Number(row.count ?? 0),
    subtotal: Number(row.subtotal ?? 0).toFixed(2),
    tax: Number(row.tax ?? 0).toFixed(2),
    total_amount: Number(row.total_amount ?? 0).toFixed(2)
  }));
}

export async function profitSummary(db, { warehouseId, from, to, buIds, assignedWarehouseIds }) {
  const conditions = ["i.type = 'SALES'", "i.status = 'COMPLETED'"];
  const params = [];
  if (warehouseId) {
    conditions.push('i.warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('i.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('i.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  const dateRange = dateRangeConditions('i.invoice_date', { from, to });
  conditions.push(...dateRange.conditions);
  params.push(...dateRange.params);

  const [rows] = await db.execute(
    `SELECT COALESCE(SUM(d.amount), 0) AS revenue, COALESCE(SUM(d.cost_amount), 0) AS cogs
     FROM invoice_details d JOIN invoices i ON i.id = d.invoice_id
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  const row = rows[0];
  const revenue = Number(row.revenue ?? 0);
  const cogs = Number(row.cogs ?? 0);
  const grossProfit = revenue - cogs;
  const grossMarginPct = revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : 0;

  return {
    revenue: revenue.toFixed(2),
    cogs: cogs.toFixed(2),
    gross_profit: grossProfit.toFixed(2),
    gross_margin_pct: grossMarginPct
  };
}
