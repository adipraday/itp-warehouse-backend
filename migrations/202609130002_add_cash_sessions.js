// Requested feature (2026-09-13), roadmap item #3: cash session / shift
// (buka-tutup kasir). Gives a physical register an audit trail — who held
// it, when, with how much starting float, and whether the drawer balances
// at close — which is the foundation daily cash reporting needs.
//
// "One open session per user" is enforced at the application layer (same
// convention this codebase already uses for "one main warehouse per BU" —
// see warehouses.service.js), not a DB constraint, since MySQL has no clean
// partial-unique-index equivalent without a generated-column workaround.
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE cash_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      warehouse_id INT NOT NULL,
      user_id INT NOT NULL,
      status ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
      opening_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      closing_amount DECIMAL(15,2) NULL,
      expected_cash_amount DECIMAL(15,2) NULL,
      cash_difference DECIMAL(15,2) NULL,
      opened_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      closed_at DATETIME(3) NULL,
      notes TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_cash_sessions_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    ) ENGINE=InnoDB
  `);
  await knex.raw('CREATE INDEX idx_cash_sessions_user_status ON cash_sessions (user_id, status)');
  await knex.raw('CREATE INDEX idx_cash_sessions_warehouse ON cash_sessions (warehouse_id)');

  // Tags each payment with the cashier's active session at the moment it was
  // recorded, so a session's close-out can sum "cash collected during THIS
  // shift" instead of guessing from a time range (fragile with overlapping
  // shifts/registers at the same warehouse). NULL for any payment posted
  // with no open session — payments remain valid without one (e.g. finance
  // recording a B2B settlement has nothing to do with a physical register).
  await knex.raw(
    'ALTER TABLE payments ADD COLUMN cash_session_id INT NULL AFTER invoice_id, ' +
      'ADD CONSTRAINT fk_payments_cash_session FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE SET NULL'
  );
  await knex.raw('CREATE INDEX idx_payments_cash_session ON payments (cash_session_id)');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE payments DROP FOREIGN KEY fk_payments_cash_session');
  await knex.raw('ALTER TABLE payments DROP COLUMN cash_session_id');
  await knex.raw('DROP TABLE IF EXISTS cash_sessions');
}
