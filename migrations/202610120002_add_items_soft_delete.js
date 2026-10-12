// Item deletion (2026-10-12): items are ARCHIVED, never physically deleted. Eight tables point at
// items(id) with ON DELETE RESTRICT (stock rows, mutations, cost layers and every document's detail
// lines), so a used item can't be removed without destroying history. `deleted_at` marks an item as
// gone from every "current items" list; the row stays so old documents keep their item name.
//
// SKU and barcode must be reusable once their item is deleted, but the existing UNIQUE (bu_id, sku) /
// (bu_id, barcode) keys would keep blocking them. `active_key` is 1 for live items and NULL for
// archived ones; including it in the unique keys keeps the one-active-item-per-SKU rule for live rows
// while letting any number of archived rows share a SKU (NULLs never collide in a unique index).
// Verified on a scratch copy of the production items table before this migration was written.
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE items
      ADD COLUMN deleted_at DATETIME(3) NULL AFTER created_by,
      ADD COLUMN deleted_by INT NULL AFTER deleted_at,
      ADD COLUMN active_key TINYINT(1) AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL AFTER deleted_by
  `);
  await knex.raw(`
    ALTER TABLE items
      DROP INDEX unique_items_bu_sku,
      DROP INDEX unique_items_bu_barcode,
      ADD UNIQUE KEY unique_items_bu_sku (bu_id, sku, active_key),
      ADD UNIQUE KEY unique_items_bu_barcode (bu_id, barcode, active_key)
  `);
}

// Rolling back fails if an archived item shares its SKU/barcode with a live one (the old keys can't
// hold both) — hard-delete or rename those rows first.
export async function down(knex) {
  await knex.raw(`
    ALTER TABLE items
      DROP INDEX unique_items_bu_sku,
      DROP INDEX unique_items_bu_barcode,
      ADD UNIQUE KEY unique_items_bu_sku (bu_id, sku),
      ADD UNIQUE KEY unique_items_bu_barcode (bu_id, barcode)
  `);
  await knex.raw('ALTER TABLE items DROP COLUMN active_key, DROP COLUMN deleted_by, DROP COLUMN deleted_at');
}
