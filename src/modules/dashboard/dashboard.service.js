import * as repository from './dashboard.repository.js';

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function getSummary(db, query, buIds = null, assignedWarehouseIds = null) {
  const warehouseId = query.warehouse_id ?? null;
  const date = query.date ?? today();

  const [stock, sales, purchases] = await Promise.all([
    repository.stockSummary(db, warehouseId, buIds, assignedWarehouseIds),
    repository.invoiceSummary(db, { type: 'SALES', warehouseId, from: date, to: date, buIds, assignedWarehouseIds }),
    repository.invoiceSummary(db, { type: 'PURCHASE', warehouseId, from: date, to: date, buIds, assignedWarehouseIds })
  ]);

  return { data: { date, stock, sales, purchases } };
}

export async function getStockDashboard(db, query, buIds = null, assignedWarehouseIds = null) {
  const data = await repository.stockSummary(db, query.warehouse_id ?? null, buIds, assignedWarehouseIds);
  return { data };
}

export async function getSalesDashboard(db, query, buIds = null, assignedWarehouseIds = null) {
  const data = await repository.invoiceSummary(db, {
    type: 'SALES',
    warehouseId: query.warehouse_id ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  });
  return { data };
}

export async function getSalesTrend(db, query, buIds = null, assignedWarehouseIds = null) {
  const data = await repository.salesTrend(db, {
    warehouseId: query.warehouse_id ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  });
  return { data };
}

export async function getPurchasesDashboard(db, query, buIds = null, assignedWarehouseIds = null) {
  const data = await repository.invoiceSummary(db, {
    type: 'PURCHASE',
    warehouseId: query.warehouse_id ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  });
  return { data };
}

export async function getProfitDashboard(db, query, buIds = null, assignedWarehouseIds = null) {
  const data = await repository.profitSummary(db, {
    warehouseId: query.warehouse_id ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  });
  return { data };
}
