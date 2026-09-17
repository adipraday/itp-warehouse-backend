// warehouses.parent_warehouse_id — self-reference for a main-warehouse/branch
// hierarchy within one business unit. NULL = main warehouse; set = branch,
// pointing at its main warehouse's id.
//
// Unlike bu_id (owned by the auth service, no FK), the parent here is a row in
// this SAME table, so a real FK is appropriate and follows the self-reference
// pattern already used by fk_inventory_transactions_reversal / fk_transfers_reversal.
// ON DELETE RESTRICT: a main warehouse with branches must have them detached
// first — enforced at the service layer with a friendlier 409 before this FK
// would ever fire.
//
// Depth (a branch's parent must itself be a main warehouse) and "at most one
// main warehouse per bu_id" are business rules, not something MySQL can express
// declaratively here (no partial unique index) — enforced in
// warehouses.service.js.
export async function up(knex) {
  await knex.raw('ALTER TABLE warehouses ADD COLUMN parent_warehouse_id INT NULL AFTER bu_id');
  await knex.raw('CREATE INDEX idx_warehouses_parent ON warehouses (parent_warehouse_id)');
  await knex.raw(`
    ALTER TABLE warehouses
      ADD CONSTRAINT fk_warehouses_parent FOREIGN KEY (parent_warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT
  `);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE warehouses DROP FOREIGN KEY fk_warehouses_parent');
  await knex.raw('DROP INDEX idx_warehouses_parent ON warehouses');
  await knex.raw('ALTER TABLE warehouses DROP COLUMN parent_warehouse_id');
}
