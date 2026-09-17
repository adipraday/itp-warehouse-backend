import { guard } from '../../shared/auth/role-matrix.js';
import { buScope } from '../../shared/auth/bu-scope.js';
import * as service from './user-warehouse-assignments.service.js';
import {
  listAssignmentsSchema,
  createAssignmentSchema,
  deleteAssignmentSchema
} from './user-warehouse-assignments.schema.js';

// Confirmed design (2026-09-09): only admin-bu (their own BU) and super-admin
// manage assignments — see MATRIX['user-warehouse-assignments'] in
// role-matrix.js, which is what actually enforces this (guard() below just
// wires it in). buScope('user-warehouse-assignments') is not a special case
// in bu-scope.js's DOC_WAREHOUSE_SQL map — it works anyway, because a plain
// `warehouse_id` in the request body/query is already checked generically by
// buScope() regardless of resource name. DELETE /:id has no warehouse_id of
// its own to check that way, so that boundary is enforced in the service
// instead (unassign() -> assertRowInScope()).
const manage = { onRequest: guard('user-warehouse-assignments', 'write') };
const scopedManage = { ...manage, preValidation: buScope('user-warehouse-assignments') };

export async function userWarehouseAssignmentsRoutes(app) {
  app.get('/', { ...scopedManage, schema: listAssignmentsSchema }, async (request) => {
    return service.listAssignments(app.db, request.query, request.userContext?.buIds);
  });

  app.post('/', { ...scopedManage, schema: createAssignmentSchema }, async (request, reply) => {
    const result = await service.assignUserToWarehouse(app.db, request.body, request.userContext?.userId);
    reply.status(201);
    return result;
  });

  app.delete('/:id', { ...manage, schema: deleteAssignmentSchema }, async (request) => {
    return service.unassign(app.db, request.params.id, request.userContext?.buIds);
  });
}
