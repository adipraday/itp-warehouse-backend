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

// Used by the push-sending helper only — never exposed over HTTP.
export async function findTokensForRoleAndBu(db, role, buId) {
  const [rows] = await db.execute('SELECT fcm_token FROM device_tokens WHERE role = ? AND bu_id = ?', [role, buId]);
  return rows.map((row) => row.fcm_token);
}

export async function removeTokens(db, tokens) {
  if (tokens.length === 0) return;
  await db.query(`DELETE FROM device_tokens WHERE fcm_token IN (${tokens.map(() => '?').join(',')})`, tokens);
}
