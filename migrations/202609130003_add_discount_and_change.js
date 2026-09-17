// Requested feature (2026-09-13), roadmap item #4: transaction-level discount
// + kembalian (change) calculation at the register.
//
// Discount is deliberately HEADER-level only (invoices.discount_amount), not
// per-line — invoice_details.amount is a GENERATED ALWAYS AS (quantity *
// unit_price) STORED column (docs/tables.sql), so a per-line discount would
// mean redefining that generated expression across all existing rows. A
// transaction-level discount ("diskon Rp10.000 dari total belanja", "diskon
// member 5%") covers the common retail case without that risk; per-line
// discounts can be added later as a dedicated follow-up if actually needed.
// Lives on the shared `invoices` table (sales + purchases both use it, same
// as unit_cost/cost_amount on invoice_details) but is only wired up on the
// SALES side for now — purchases rows simply keep the DEFAULT 0.
//
// Change: a cash payment can hand over more than the invoice actually owes
// (amount_tendered) — the excess (change_amount) goes back to the customer
// and was never really applied to the invoice. `amount` keeps meaning exactly
// what it always has ("applied to this invoice's balance" — cash-sessions.js's
// reconciliation still sums plain `amount`, since amount_tendered - change_amount
// always equals amount, i.e. what actually stays in the drawer).
export async function up(knex) {
  await knex.raw(
    'ALTER TABLE invoices ADD COLUMN discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0 ' +
      'CHECK (discount_amount >= 0) AFTER subtotal'
  );
  await knex.raw('ALTER TABLE payments ADD COLUMN amount_tendered DECIMAL(15,2) NULL AFTER amount');
  await knex.raw(
    'ALTER TABLE payments ADD COLUMN change_amount DECIMAL(15,2) NOT NULL DEFAULT 0 ' +
      'CHECK (change_amount >= 0) AFTER amount_tendered'
  );
}

export async function down(knex) {
  await knex.raw('ALTER TABLE payments DROP COLUMN change_amount');
  await knex.raw('ALTER TABLE payments DROP COLUMN amount_tendered');
  await knex.raw('ALTER TABLE invoices DROP COLUMN discount_amount');
}
