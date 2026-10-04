const COLUMNS = 'id, user_id, fcm_token, role, bu_id, platform, created_at, updated_at';

// role/bu_id are denormalized from the caller's JWT at registration time
// (see device-tokens.service.js) — re-registering (e.g. every app login)
// refreshes them, so a role/BU change takes effect on the next login rather
// than requiring a separate sync step.
export async function upsert(db, { user_id, fcm_token, role, bu_id, platform }) {
  await db.execute(
    `INSERT INTO device_tokens (user_id, fcm_token, role, bu_id, platform)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), role = VALUES(role), bu_id = VALUES(bu_id), platform = VALUES(platform)`,
    [user_id, fcm_token, role, bu_id, platform]
  );
  return findByToken(db, fcm_token);
}

export async function findByToken(db, fcm_token) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM device_tokens WHERE fcm_token = ?`, [fcm_token]);
  return rows[0] ?? null;
}

export async function remove(db, fcm_token) {
  await db.execute('DELETE FROM device_tokens WHERE fcm_token = ?', [fcm_token]);
}

// Used by the push-sending helper only — never exposed over HTTP. Returns
// {user_id, fcm_token} rows (not just tokens) — push.js needs user_id to
// write a notification-inbox row per recipient, not just a token to send to.
export async function findTokensForRoleAndBu(db, role, buId) {
  const [rows] = await db.execute(
    'SELECT user_id, fcm_token FROM device_tokens WHERE role = ? AND bu_id = ?',
    [role, buId]
  );
  return rows;
}

// For a role that isn't BU-scoped (e.g. `owner`). Tokens of these roles are
// stored with bu_id NULL, so the token row alone can't say which tenant a
// device belongs to. Without a buId: every device registered under the role,
// regardless of tenant (original behaviour, still used by callers that really
// mean "everyone"). With a buId (an event that belongs to ONE business unit):
// only devices whose owner's verified token covers that BU — resolved through
// user_directory, which carries the JWT's bu_ids (an owner's = every BU of
// their own company; NULL = the unrestricted claim) and a fresher role than
// the denormalized one on the token row. A device whose user isn't in
// user_directory yet is EXCLUDED (fail closed): this is a tenant boundary, so a
// device we can't place must not receive another company's data. It joins the
// audience on the owner's next authenticated request.
export async function findTokensForRole(db, role, buId = null) {
  if (buId == null) {
    const [rows] = await db.execute('SELECT user_id, fcm_token FROM device_tokens WHERE role = ?', [role]);
    return rows;
  }
  const [rows] = await db.execute(
    `SELECT dt.user_id, dt.fcm_token
     FROM device_tokens dt
     JOIN user_directory ud ON ud.user_id = dt.user_id
     WHERE dt.role = ? AND ud.role = ? AND (ud.bu_ids IS NULL OR JSON_CONTAINS(ud.bu_ids, ?))`,
    [role, role, String(buId)]
  );
  return rows;
}

// For the staff actually assigned to a specific warehouse (not BU-wide) —
// joins against user_warehouse_assignments, so this only reaches people who
// work at THIS warehouse, not every admin-warehouse/staff-gudang/etc in the
// whole BU.
export async function findTokensForWarehouseStaff(db, warehouseId, roles) {
  if (roles.length === 0) return [];
  const placeholders = roles.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT DISTINCT dt.user_id, dt.fcm_token
     FROM device_tokens dt
     JOIN user_warehouse_assignments uwa ON uwa.user_id = dt.user_id
     WHERE uwa.warehouse_id = ? AND dt.role IN (${placeholders})`,
    [warehouseId, ...roles]
  );
  return rows;
}

export async function removeTokens(db, tokens) {
  if (tokens.length === 0) return;
  await db.query(`DELETE FROM device_tokens WHERE fcm_token IN (${tokens.map(() => '?').join(',')})`, tokens);
}
