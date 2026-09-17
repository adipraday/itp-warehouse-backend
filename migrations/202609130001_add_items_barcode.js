// Requested feature (2026-09-13): barcode scanner support at the cash
// register. `sku` already exists but is meant as an internal product code
// (frontend-typed), not necessarily the printed barcode value — a supplier's
// barcode can differ from how a shop codes the item internally, and reusing
// `sku` would force every item to be renamed to match whatever's printed on
// the package. Nullable + unique: not every item needs a barcode yet, but two
// items can never share one once set.
export async function up(knex) {
  await knex.raw('ALTER TABLE items ADD COLUMN barcode VARCHAR(64) NULL UNIQUE AFTER sku');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE items DROP COLUMN barcode');
}
