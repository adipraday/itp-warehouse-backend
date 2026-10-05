const COLUMNS = 'id, user_id, title, body, type, data, is_read, created_at';

function parseRow(row) {
  // data is a JSON column: a string with the pool's jsonStrings, an object if
  // mysql2 ever decodes it itself (MariaDB 10.5+ without jsonStrings).
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? null);
  return { ...row, is_read: Boolean(row.is_read), data };
}

// Called from push.js's sendToTokens, after deduping recipients down to
// unique user_ids — one inbox row per targeted user, regardless of how many
// devices they have registered or whether the FCM send itself succeeds.
export async function createForUsers(db, userIds, { title, body, type, data = null }) {
  if (userIds.length === 0) return;
  const serializedData = data ? JSON.stringify(data) : null;
  const values = userIds.map(() => '(?, ?, ?, ?, ?)');
  const params = userIds.flatMap((userId) => [userId, title, body, type, serializedData]);
  await db.execute(
    `INSERT INTO notifications (user_id, title, body, type, data) VALUES ${values.join(', ')}`,
    params
  );
}

export async function findByUser(db, userId, { limit, offset }) {
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  return rows.map(parseRow);
}

export async function countByUser(db, userId) {
  const [rows] = await db.execute('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?', [userId]);
  return Number(rows[0].total);
}

export async function countUnreadByUser(db, userId) {
  const [rows] = await db.execute(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId]
  );
  return Number(rows[0].total);
}

export async function findByIdAndUser(db, id, userId) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM notifications WHERE id = ? AND user_id = ?`, [id, userId]);
  return rows[0] ? parseRow(rows[0]) : null;
}

export async function markRead(db, id, userId) {
  await db.execute('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
}

export async function markAllRead(db, userId) {
  const [result] = await db.execute(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
    [userId]
  );
  return result.affectedRows;
}
