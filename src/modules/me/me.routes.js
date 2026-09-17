import { STAFF_ROLES } from '../../shared/auth/warehouse-assignment.js';
import { accessStatusSchema } from './me.schema.js';

// Dedicated status-check endpoint (2026-09-09) — the one /api/* route a staff
// user with zero warehouse assignments can still reach (see the explicit
// exemption in src/shared/auth/warehouse-assignment.js), so the frontend has
// somewhere to ask "am I set up yet?" and redirect to the "Akses Anda belum
// disiapkan" notice page when assigned === false, instead of every other call
// just failing with WAREHOUSE_ACCESS_NOT_CONFIGURED.
export async function meRoutes(app) {
  app.get('/access-status', { schema: accessStatusSchema }, async (request) => {
    const ctx = request.userContext;
    const isStaff = ctx && STAFF_ROLES.includes(ctx.role);
    return {
      data: {
        role: ctx?.role ?? null,
        assigned: isStaff ? (ctx.assignedWarehouseIds ?? []).length > 0 : true,
        warehouse_ids: isStaff ? ctx.assignedWarehouseIds ?? [] : null
      }
    };
  });
}
