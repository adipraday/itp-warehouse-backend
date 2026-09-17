// warehouses.bu_id — which business unit owns this warehouse.
// Plain nullable INT with no FK: the canonical business_units table lives in the
// auth service, not this database (same pattern as created_by). NULL = not yet
// assigned to any BU (only super-admin may touch such a warehouse).
export async function up(knex) {
  await knex.raw('ALTER TABLE warehouses ADD COLUMN bu_id INT NULL AFTER address');
  await knex.raw('CREATE INDEX idx_warehouses_bu ON warehouses (bu_id)');
}

export async function down(knex) {
  await knex.raw('DROP INDEX idx_warehouses_bu ON warehouses');
  await knex.raw('ALTER TABLE warehouses DROP COLUMN bu_id');
}
