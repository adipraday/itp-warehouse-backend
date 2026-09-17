import { parsePagination } from '../../../shared/utils/pagination.js';
import * as repository from './stocks.repository.js';

export async function listStocks(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = { warehouseId: query.warehouse_id ?? null, itemId: query.item_id ?? null, buIds, assignedWarehouseIds };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function listLowStock(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const warehouseId = query.warehouse_id ?? null;
  const [data, total] = await Promise.all([
    repository.findLowStock(db, { warehouseId, buIds, assignedWarehouseIds, limit: per_page, offset }),
    repository.countLowStock(db, { warehouseId, buIds, assignedWarehouseIds })
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function listOutOfStock(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const warehouseId = query.warehouse_id ?? null;
  const [data, total] = await Promise.all([
    repository.findOutOfStock(db, { warehouseId, buIds, assignedWarehouseIds, limit: per_page, offset }),
    repository.countOutOfStock(db, { warehouseId, buIds, assignedWarehouseIds })
  ]);
  return { data, meta: { page, per_page, total } };
}
