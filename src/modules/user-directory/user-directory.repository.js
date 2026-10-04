// Token-independent recipient lookup for the notification inbox — see the
// header comment in migrations/202610050001_add_user_directory.js. Never
// exposed over HTTP; only push.js (via the recorder in
// shared/auth/user-directory-sync.js) reads/writes here. Every finder returns
// plain user_id numbers, since an inbox row needs a user, not a device.

export async function upsert(db, { user_id, role, bu_id, bu_ids }) {
  await db.execute(
    `INSERT INTO user_directory (user_id, role, bu_id, bu_ids)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), bu_id = VALUES(bu_id), bu_ids = VALUES(bu_ids), last_seen_at = CURRENT_TIMESTAMP(3)`,
    [user_id, role, bu_id ?? null, bu_ids == null ? null : JSON.stringify(bu_ids)]
  );
}

// BU-scoped roles (admin-bu, purchasing, finance, ...): home BU, or — for an
// admin-bu with grants — any BU in the token's bu_ids.
export async function findUserIdsForRoleAndBu(db, role, buId) {
  const [rows] = await db.execute(
    'SELECT user_id FROM user_directory WHERE role = ? AND (bu_id = ? OR JSON_CONTAINS(bu_ids, ?))',
    [role, buId, String(buId)]
  );
  return rows.map((row) => row.user_id);
}

// Roles that aren't BU-scoped (owner). With a buId, narrowed to the owners
// whose token covers that BU (an owner's bu_ids = every BU in their company;
// a NULL bu_ids is the unrestricted claim, so it always matches). Without a
// buId, every user of the role — same behaviour as the device-token side.
export async function findUserIdsForRole(db, role, buId = null) {
  if (buId == null) {
    const [rows] = await db.execute('SELECT user_id FROM user_directory WHERE role = ?', [role]);
    return rows.map((row) => row.user_id);
  }
  const [rows] = await db.execute(
    'SELECT user_id FROM user_directory WHERE role = ? AND (bu_ids IS NULL OR JSON_CONTAINS(bu_ids, ?))',
    [role, String(buId)]
  );
  return rows.map((row) => row.user_id);
}

// Staff actually assigned to a specific warehouse (not BU-wide) — same join as
// device-tokens.repository.findTokensForWarehouseStaff, minus the tokens.
export async function findUserIdsForWarehouseStaff(db, warehouseId, roles) {
  if (roles.length === 0) return [];
  const placeholders = roles.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT DISTINCT ud.user_id
     FROM user_directory ud
     JOIN user_warehouse_assignments uwa ON uwa.user_id = ud.user_id
     WHERE uwa.warehouse_id = ? AND ud.role IN (${placeholders})`,
    [warehouseId, ...roles]
  );
  return rows.map((row) => row.user_id);
}
