// items.bu_id / contacts.bu_id — closes a real cross-tenant data leak found
// 2026-09-08: items & contacts were global master data with NO business-unit
// scoping at all, so a brand-new company (a genuinely separate tenant, not just
// another BU in the same company) could see every item/contact ever seeded by
// any other company. Same pattern as warehouses.bu_id: plain nullable INT, no
// FK (business_units lives in the auth service, not this database). NULL =
// unassigned (only super-admin may touch such a row) — same convention used
// everywhere else in this codebase.
//
// Deliberately does NOT backfill existing rows here — that would mean hardcoding
// a bu_id number in a migration, exactly the mistake this whole area of the
// codebase was fixed to avoid (see docs/bug-report-bu-id-mismatch.md). Existing
// rows stay NULL after this migration; run scripts/backfill-items-contacts-bu.mjs
// separately to resolve a target BU by `code` and backfill them.
export async function up(knex) {
  await knex.raw('ALTER TABLE items ADD COLUMN bu_id INT NULL AFTER id');
  await knex.raw('CREATE INDEX idx_items_bu ON items (bu_id)');
  await knex.raw('ALTER TABLE contacts ADD COLUMN bu_id INT NULL AFTER id');
  await knex.raw('CREATE INDEX idx_contacts_bu ON contacts (bu_id)');
}

export async function down(knex) {
  await knex.raw('DROP INDEX idx_contacts_bu ON contacts');
  await knex.raw('ALTER TABLE contacts DROP COLUMN bu_id');
  await knex.raw('DROP INDEX idx_items_bu ON items');
  await knex.raw('ALTER TABLE items DROP COLUMN bu_id');
}
