// Per-warehouse staff scoping (2026-09-09, docs/user-warehouse-assignments.md).
//
// WHY THIS EXISTS: bu_ids (docs/auth-multitenant-coordination.md §7) scopes a
// caller to a set of BUSINESS UNITS, not individual warehouses. That's not
// enough for a BU that runs more than one warehouse (e.g. "Pusat" + "Cabang")
// and wants staff-gudang/kasir-sales/purchasing/finance confined to only the
// warehouse they actually work at — the auth-backend token has no warehouse-
// level claim, and adding one there would mean every warehouse move requires a
// re-login/re-issue across a service that doesn't own warehouses. So this
// lives entirely in warehouse-backend's own database instead: a
// user_warehouse_assignments table (see the 202609090002 migration), owned and
// enforced here, with no auth-backend/token changes at all.
//
// SCOPE — deliberately narrow:
//   - Only STAFF_ROLES are subject to this. admin-bu/owner/super-admin keep
//     their existing BU-wide (or global) scope unchanged — assigning them to
//     one warehouse would contradict what those roles are for.
//   - A staff user is looked up by user_id on every /api/* request. Zero
//     assignments -> the request is blocked outright (403,
//     WAREHOUSE_ACCESS_NOT_CONFIGURED), except the one status-check endpoint
//     the frontend needs to detect this and redirect to its "not set up yet"
//     notice page. This was a deliberate design call (block everything, not
//     just writes) — a staff user with no assigned warehouse has nothing
//     meaningful to read either.
//   - One OR MORE assignments -> request.userContext.assignedWarehouseIds is
//     set to that list. Existing bu_id scoping (bu-filter.js) is untouched;
//     this is an ADDITIONAL, narrower filter layered on top via
//     assignedWarehouseCondition() — a staff user assigned to "Cabang" still
//     can't see another BU's data (bu_ids still applies) AND can't see
//     "Pusat" within their own BU (this applies too).
//
// admin-bu/owner/super-admin never get assignedWarehouseIds set (stays
// undefined) — every call site treats "not present" the same as "not
// restricted", identically to how buIds === null means unrestricted.
export const STAFF_ROLES = ['staff-gudang', 'kasir-sales', 'purchasing', 'finance'];

// The one endpoint an unassigned staff user must still be able to reach, so
// the frontend can detect WAREHOUSE_ACCESS_NOT_CONFIGURED and redirect —
// otherwise a user with zero assignments could never even find out why.
const STATUS_CHECK_PATH = '/api/me/access-status';

function accessNotConfigured() {
  const error = new Error(
    'Akses Anda belum disiapkan — hubungi admin-bu Anda untuk di-assign ke warehouse.'
  );
  error.statusCode = 403;
  error.code = 'WAREHOUSE_ACCESS_NOT_CONFIGURED';
  return error;
}

export async function registerWarehouseAssignment(app) {
  app.addHook('onRequest', async (request) => {
    const ctx = request.userContext;

    if (!request.url.startsWith('/api/')) return; // health/docs/root — untouched
    if (!ctx || !ctx.userId) return; // no identity — hybrid/header lenient, jwt already rejected upstream
    if (!STAFF_ROLES.includes(ctx.role)) return; // admin-bu/owner/super-admin/unknown — exempt

    const [rows] = await app.db.execute(
      'SELECT warehouse_id FROM user_warehouse_assignments WHERE user_id = ?',
      [ctx.userId]
    );
    const assignedWarehouseIds = rows.map((row) => Number(row.warehouse_id));
    ctx.assignedWarehouseIds = assignedWarehouseIds;

    if (assignedWarehouseIds.length === 0 && request.url.split('?')[0] !== STATUS_CHECK_PATH) {
      throw accessNotConfigured();
    }
  });
}
