// Bug fix (2026-09-14): items.sku was globally unique, not scoped per business
// unit — two completely unrelated tenants could never both use "SKU-001",
// which is a real-world certainty for any two independent businesses. Same
// class of incident as docs/bug-report-items-contacts-cross-tenant-leak.md
// (2026-09-08), that one was about read visibility; this one is the write-side
// uniqueness constraint. Found while designing the item/stock import feature —
// an SKU-based upsert against a GLOBAL uniqueness check could otherwise update
// a completely different business's item by SKU collision.
//
// barcode is deliberately left globally unique (confirmed with the user,
// 2026-09-14) — a barcode is a real-world physical product code (EAN/UPC),
// unlike an internally-assigned SKU.
//
// Safe to run with zero data risk: going from UNIQUE(sku) to UNIQUE(bu_id, sku)
// only ever ALLOWS combinations that were previously impossible (two different
// bu_id values sharing an sku) — it can't conflict with any existing row.
export async function up(knex) {
  await knex.raw('ALTER TABLE items DROP INDEX sku');
  await knex.raw('ALTER TABLE items ADD UNIQUE KEY unique_items_bu_sku (bu_id, sku)');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE items DROP INDEX unique_items_bu_sku');
  await knex.raw('ALTER TABLE items ADD UNIQUE KEY sku (sku)');
}
