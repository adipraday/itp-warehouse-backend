// Bug fix (2026-09-14), same class as the sku fix earlier today
// (202609140001) — found via a real user report: `barcode` was globally
// unique, so once one business registered a real-world product's barcode
// (e.g. a cigarette pack's EAN, "8994796151294"), NO other unrelated business
// in the system could ever register that same physical product again. The
// original reasoning ("barcode is a real-world product code, so global
// uniqueness makes sense") turned out to be backwards: a barcode identifies
// the PRODUCT, not who's allowed to sell it — two unrelated shops stocking
// the identical manufactured item is the ordinary case, not an edge case.
//
// Same safety property as the sku migration: UNIQUE(barcode) -> UNIQUE(bu_id,
// barcode) only ever ALLOWS combinations that were previously impossible, so
// this can never conflict with existing data.
export async function up(knex) {
  await knex.raw('ALTER TABLE items DROP INDEX barcode');
  await knex.raw('ALTER TABLE items ADD UNIQUE KEY unique_items_bu_barcode (bu_id, barcode)');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE items DROP INDEX unique_items_bu_barcode');
  await knex.raw('ALTER TABLE items ADD UNIQUE KEY barcode (barcode)');
}
