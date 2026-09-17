// created_by / approved_by / completed_by are plain nullable INT references
// (no FK) because the users table lives in a separate auth service, not in
// this database. activity_logs.user_id is nullable for the same reason plus
// the transition period before real auth is wired in (see shared/auth).
export async function up(knex) {
  const statements = [
    `CREATE TABLE activity_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      warehouse_id INT NULL,
      action VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id INT NULL,
      method VARCHAR(10) NOT NULL,
      endpoint VARCHAR(255) NOT NULL,
      status_code INT NOT NULL,
      metadata JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`,
    'CREATE INDEX idx_activity_logs_user ON activity_logs (user_id, created_at)',
    'CREATE INDEX idx_activity_logs_entity ON activity_logs (entity_type, entity_id)',
    'CREATE INDEX idx_activity_logs_warehouse ON activity_logs (warehouse_id, created_at)',

    'ALTER TABLE warehouses ADD COLUMN created_by INT NULL',
    'ALTER TABLE items ADD COLUMN created_by INT NULL',
    'ALTER TABLE contacts ADD COLUMN created_by INT NULL',
    'ALTER TABLE inventory_transactions ADD COLUMN created_by INT NULL, ADD COLUMN completed_by INT NULL',
    'ALTER TABLE stock_transfers ADD COLUMN created_by INT NULL, ADD COLUMN approved_by INT NULL, ADD COLUMN completed_by INT NULL',
    'ALTER TABLE stock_opnames ADD COLUMN created_by INT NULL, ADD COLUMN approved_by INT NULL',
    'ALTER TABLE invoices ADD COLUMN created_by INT NULL, ADD COLUMN completed_by INT NULL',
    'ALTER TABLE item_returns ADD COLUMN created_by INT NULL, ADD COLUMN approved_by INT NULL, ADD COLUMN completed_by INT NULL',
    'ALTER TABLE payments ADD COLUMN created_by INT NULL'
  ];

  for (const statement of statements) await knex.raw(statement);
}

export async function down(knex) {
  const alters = [
    'ALTER TABLE payments DROP COLUMN created_by',
    'ALTER TABLE item_returns DROP COLUMN created_by, DROP COLUMN approved_by, DROP COLUMN completed_by',
    'ALTER TABLE invoices DROP COLUMN created_by, DROP COLUMN completed_by',
    'ALTER TABLE stock_opnames DROP COLUMN created_by, DROP COLUMN approved_by',
    'ALTER TABLE stock_transfers DROP COLUMN created_by, DROP COLUMN approved_by, DROP COLUMN completed_by',
    'ALTER TABLE inventory_transactions DROP COLUMN created_by, DROP COLUMN completed_by',
    'ALTER TABLE contacts DROP COLUMN created_by',
    'ALTER TABLE items DROP COLUMN created_by',
    'ALTER TABLE warehouses DROP COLUMN created_by'
  ];
  for (const statement of alters) await knex.raw(statement);
  await knex.raw('DROP TABLE IF EXISTS activity_logs');
}
