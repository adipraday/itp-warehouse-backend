import { buScope } from '../../shared/auth/bu-scope.js';
import * as service from './activity-logs.service.js';
import { listActivityLogsSchema, getActivityLogSchema } from './activity-logs.schema.js';

// Real scoping (2026-09-08) — replaces the authorize('super-admin') stopgap.
// bu-scope.js has no DOC_WAREHOUSE_SQL entry for 'activity-logs' (a log entry
// doesn't reference a warehouse the way a business document does), so this
// preValidation is a no-op for :id — the actual per-row check happens in
// getActivityLog() (404, not 403 — see activity-logs.service.js).
const scope = buScope('activity-logs');

export async function activityLogsRoutes(app) {
  app.get('/', { preValidation: scope, schema: listActivityLogsSchema }, async (request) => {
    return service.listActivityLogs(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { preValidation: scope, schema: getActivityLogSchema }, async (request) => {
    return service.getActivityLog(
      app.db,
      request.params.id,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });
}
