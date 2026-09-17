// Requested feature (2026-09-13), roadmap item #5: hold/park a transaction at
// the register — a cashier building a cart who needs to serve someone else
// (customer forgot their wallet, stepped away, etc.) can park it and pick it
// back up later without losing the cart.
//
// Deliberately NOT a new state in the DRAFT->COMPLETED/CANCELLED machine — a
// held sale is still a perfectly normal DRAFT, just tagged with when it was
// parked and an optional friendly label ("Meja 5", "Budi"). This keeps the
// existing DRAFT editing/completing/cancelling flow completely untouched;
// hold/resume are purely a marker on top of it, and `held_at` is what a
// "Held Transactions" screen filters/sorts on.
//
// Lives on the shared `invoices` table (sales + purchases) but is only wired
// up on the SALES side, same precedent as discount_amount/cash_session_id.
export async function up(knex) {
  await knex.raw('ALTER TABLE invoices ADD COLUMN held_at DATETIME(3) NULL AFTER status');
  await knex.raw('ALTER TABLE invoices ADD COLUMN hold_label VARCHAR(100) NULL AFTER held_at');
  await knex.raw('CREATE INDEX idx_invoices_held_at ON invoices (held_at)');
}

export async function down(knex) {
  await knex.raw('DROP INDEX idx_invoices_held_at ON invoices');
  await knex.raw('ALTER TABLE invoices DROP COLUMN hold_label');
  await knex.raw('ALTER TABLE invoices DROP COLUMN held_at');
}
