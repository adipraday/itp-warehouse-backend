import { NotFoundError, ConflictError } from '../../shared/errors/app-error.js';
import { assertRowInScope } from '../../shared/auth/master-data-scope.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import * as repository from './user-warehouse-assignments.repository.js';

export async function listAssignments(db, query, buIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = { userId: query.user_id, warehouseId: query.warehouse_id, buIds };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

// warehouse_id's bu_id membership is validated upstream by buScope() (a
// preValidation hook, wired in the routes) before this ever runs — this
// service trusts that and only handles the assignment-specific business rule.
export async function assignUserToWarehouse(db, { user_id, warehouse_id }, assignedBy = null) {
  const existing = await repository.findByUserAndWarehouse(db, user_id, warehouse_id);
  if (existing) {
    throw new ConflictError(
      'ASSIGNMENT_EXISTS',
      `User ${user_id} is already assigned to warehouse ${warehouse_id}`
    );
  }
  const row = await repository.create(db, { user_id, warehouse_id, assigned_by: assignedBy });
  return { data: row };
}

// DELETE /:id has no warehouse_id in its own body/query for buScope() to
// check, so the BU boundary is enforced here instead, the same way
// items/contacts validate a fetched row against the caller's buIds.
export async function unassign(db, id, buIds = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Assignment ${id} not found`);
  assertRowInScope(existing, buIds, 'Assignment');
  await repository.remove(db, id);
  return { data: { id: Number(id) } };
}
