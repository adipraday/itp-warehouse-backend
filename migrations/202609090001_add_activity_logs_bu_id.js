// activity_logs.bu_id — closes the gap found 2026-09-08: this module was
// missed when bu-filter.js scoping rolled out to the other 15 modules,
// letting any authenticated user read the full cross-tenant audit trail
// (stopgap `authorize('super-admin')` applied in the meantime — see
// activity-logs.routes.js and docs/auth-multitenant-coordination.md §9).
//
// Same nullable-INT-no-FK pattern as every other bu_id column here.
// Backfilled from warehouses.bu_id (same database, already-resolved value —
// NOT a hardcoded auth-backend id, so this doesn't repeat the mistake in
// docs/bug-report-bu-id-mismatch.md). Rows with no warehouse_id (~70% of
// existing data, per investigation) stay bu_id NULL — visible to super-admin
// only, same convention as every other unassigned row in this codebase.
export async function up(knex) {
  await knex.raw('ALTER TABLE activity_logs ADD COLUMN bu_id INT NULL AFTER warehouse_id');
  await knex.raw('CREATE INDEX idx_activity_logs_bu ON activity_logs (bu_id, created_at)');
  await knex.raw(`
    UPDATE activity_logs al
    JOIN warehouses w ON w.id = al.warehouse_id
    SET al.bu_id = w.bu_id
    WHERE al.warehouse_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw('DROP INDEX idx_activity_logs_bu ON activity_logs');
  await knex.raw('ALTER TABLE activity_logs DROP COLUMN bu_id');
}
