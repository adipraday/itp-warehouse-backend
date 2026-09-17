// Validates access to "master data" that carries its own bu_id directly
// (items, contacts) — both when the row IS the target (GET/PUT /api/items/:id)
// and when it's merely REFERENCED by another document (an inbound detail
// line's item_id, a sale's contact_id, etc.).
//
// WHY THIS EXISTS: found 2026-09-08 — items/contacts had NO bu_id at all, so a
// brand-new company (a genuinely separate tenant) could see, and reference in
// its own transactions, every other company's item/contact catalog. Same class
// of incident as docs/bug-report-bu-id-mismatch.md, different tables.
//
// buIds === null (super-admin) always passes. A row whose own bu_id is NULL
// (unassigned — legacy data, or created before this fix) is usable ONLY by
// super-admin, same convention as warehouses.bu_id.

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  return error;
}

function isAllowed(rowBuId, buIds) {
  if (buIds == null) return true;
  if (rowBuId == null) return false;
  return buIds.map(Number).includes(Number(rowBuId));
}

// Throws if an already-fetched row (an item or contact) isn't visible to
// buIds. No-op if row is falsy — let the caller's own 404 handling run first.
export function assertRowInScope(row, buIds, label) {
  if (!row) return;
  if (!isAllowed(row.bu_id, buIds)) {
    throw forbidden(`${label} ${row.id} is outside your business unit`);
  }
}

// Bulk-validates every id in `itemIds` (deduplicated, nullish entries ignored)
// is an item the caller may reference — call before creating/updating any
// detail line that carries item_id (inbound, outbound, sale, purchase, return,
// transfer, opname).
export async function assertItemsInScope(db, itemIds, buIds) {
  if (buIds == null) return;
  const ids = [...new Set(itemIds)].filter((id) => id != null);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await db.execute(`SELECT id, bu_id FROM items WHERE id IN (${placeholders})`, ids);
  for (const row of rows) {
    if (!isAllowed(row.bu_id, buIds)) {
      throw forbidden(`item ${row.id} is outside your business unit`);
    }
  }
  // An id with no matching row (nonexistent item) is left alone here — the
  // caller's own FK constraint / not-found handling deals with that case.
}

// Validates a single contact_id, if one was given — call before creating any
// document header that carries contact_id (inbound, outbound, sale, purchase, return).
export async function assertContactInScope(db, contactId, buIds) {
  if (buIds == null || contactId == null) return;
  const [rows] = await db.execute('SELECT id, bu_id FROM contacts WHERE id = ?', [contactId]);
  const row = rows[0];
  if (!row) return;
  if (!isAllowed(row.bu_id, buIds)) {
    throw forbidden(`contact ${contactId} is outside your business unit`);
  }
}
