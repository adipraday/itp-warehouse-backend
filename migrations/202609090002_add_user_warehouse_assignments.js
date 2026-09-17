// New feature (2026-09-09, requested): let admin-bu pin a staff-level user
// (staff-gudang, kasir-sales, purchasing, finance) to specific warehouse(s)
// within their BU, so "staff at Pusat" and "staff at Cabang" don't see each
// other's data even though both warehouses share the same bu_id. Deliberately
// lives entirely in warehouse-backend's own database — no auth-backend schema
// or token-contract change needed, consistent with "auth = identity, warehouse
// = resource authorization." admin-bu/owner/super-admin are never subject to
// this — they keep their existing BU-wide (or global) scope unchanged.
//
// user_id: plain nullable-less INT, no FK (users live in the auth service,
// same pattern as created_by everywhere else). warehouse_id: real FK — this
// IS the same database.
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE user_warehouse_assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      warehouse_id INT NOT NULL,
      assigned_by INT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_user_warehouse (user_id, warehouse_id),
      CONSTRAINT fk_uwa_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await knex.raw('CREATE INDEX idx_uwa_user ON user_warehouse_assignments (user_id)');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS user_warehouse_assignments');
}
