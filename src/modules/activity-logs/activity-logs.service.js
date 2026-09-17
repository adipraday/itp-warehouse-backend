import { NotFoundError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import * as repository from './activity-logs.repository.js';

export async function listActivityLogs(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    userId: query.user_id ?? null,
    warehouseId: query.warehouse_id ?? null,
    entityType: query.entity_type ?? null,
    entityId: query.entity_id ?? null,
    action: query.action ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, filter, { limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getActivityLog(db, id, buIds = null, assignedWarehouseIds = null) {
  const log = await repository.findById(db, id);
  if (!log) throw new NotFoundError(`Activity log ${id} not found`);

  // 404, not 403: don't reveal that a log outside the caller's BU(s) even
  // exists — activity-log ids/volume is itself sensitive cross-tenant info.
  const inBuScope = buIds == null || (log.bu_id != null && buIds.map(Number).includes(Number(log.bu_id)));
  // Same reasoning for a staff user's per-warehouse assignment: a log for a
  // warehouse they're not assigned to reads as 404, not "not your BU".
  const inWarehouseScope =
    assignedWarehouseIds == null ||
    (log.warehouse_id != null && assignedWarehouseIds.map(Number).includes(Number(log.warehouse_id)));
  if (!inBuScope || !inWarehouseScope) throw new NotFoundError(`Activity log ${id} not found`);

  return { data: log };
}
