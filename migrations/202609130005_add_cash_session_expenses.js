// Requested feature (2026-09-13), cash-session follow-up: operational
// expenses paid straight out of the register's cash (e.g. "beli galon air",
// ongkos kirim) — cash physically leaving the drawer mid-shift that was never
// a sale/payment. Without this, cash-sessions.close() has no way to know
// about it, so a legitimate withdrawal shows up as a false "shortage"
// (cash_difference) at close time — this table is what fixes that.
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE cash_session_expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cash_session_id INT NOT NULL,
      amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
      description VARCHAR(255) NOT NULL,
      created_by INT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_cash_session_expenses_session FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await knex.raw('CREATE INDEX idx_cash_session_expenses_session ON cash_session_expenses (cash_session_id)');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS cash_session_expenses');
}
