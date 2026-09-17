import { NotFoundError } from '../../../shared/errors/app-error.js';
import { parsePagination } from '../../../shared/utils/pagination.js';
import * as costLayersRepository from './cost-layers.repository.js';

export async function listCostLayers(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    warehouseId: query.warehouse_id ?? null,
    itemId: query.item_id ?? null,
    remainingOnly: query.remaining_only === true,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    costLayersRepository.findAll(db, filter, { limit: per_page, offset }),
    costLayersRepository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getCostLayer(db, id) {
  const layer = await costLayersRepository.findById(db, id);
  if (!layer) throw new NotFoundError(`Cost layer ${id} not found`);
  return { data: layer };
}

export async function getCostSummary(db, query, buIds = null, assignedWarehouseIds = null) {
  const summary = await costLayersRepository.summary(db, {
    warehouseId: query.warehouse_id ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  });
  return { data: summary };
}
