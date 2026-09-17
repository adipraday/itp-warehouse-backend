import { directBuIdsCondition } from '../../shared/auth/bu-filter.js';

// A 'both' contact is simultaneously a supplier and a customer, so it must
// surface in either filtered list rather than only an exact type match.
function buildFilter({ type, buIds }) {
  const conditions = [];
  const params = [];
  if (type === 'both') {
    conditions.push('type = ?');
    params.push('both');
  } else if (type) {
    conditions.push('type IN (?, ?)');
    params.push(type, 'both');
  }
  const bu = directBuIdsCondition('bu_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

const COLUMNS = 'id, bu_id, type, name, phone, email, address, created_by, created_at, updated_at';

export async function findAll(db, { type, buIds, limit, offset }) {
  const { clause, params } = buildFilter({ type, buIds });
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM contacts ${clause} ORDER BY name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { type, buIds }) {
  const { clause, params } = buildFilter({ type, buIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM contacts ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM contacts WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function create(db, { type, name, phone = null, email = null, address = null, bu_id = null }, createdBy = null) {
  const [result] = await db.execute(
    'INSERT INTO contacts (type, name, phone, email, address, bu_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [type, name, phone, email, address, bu_id, createdBy]
  );
  return findById(db, result.insertId);
}

export async function update(db, id, { type, name, phone = null, email = null, address = null, bu_id = null }) {
  await db.execute(
    'UPDATE contacts SET type = ?, name = ?, phone = ?, email = ?, address = ?, bu_id = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
    [type, name, phone, email, address, bu_id, id]
  );
  return findById(db, id);
}
