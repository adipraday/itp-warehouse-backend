import { NotFoundError } from '../../../shared/errors/app-error.js';
import { parsePagination } from '../../../shared/utils/pagination.js';
import * as repository from './stock-mutations.repository.js';

function buildQueryFilter(query, buIds, assignedWarehouseIds) {
  return {
    warehouseId: query.warehouse_id ?? null,
    itemId: query.item_id ?? null,
    type: query.type ?? null,
    direction: query.direction ?? null,
    sourceType: query.source_type ?? null,
    sourceId: query.source_id ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  };
}

export async function listStockMutations(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = buildQueryFilter(query, buIds, assignedWarehouseIds);
  const [data, total] = await Promise.all([
    repository.findAll(db, filter, { limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getStockMutation(db, id) {
  const mutation = await repository.findById(db, id);
  if (!mutation) throw new NotFoundError(`Stock mutation ${id} not found`);
  return { data: mutation };
}
