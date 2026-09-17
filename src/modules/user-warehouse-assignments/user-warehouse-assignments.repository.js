import { directBuIdsCondition } from '../../shared/auth/bu-filter.js';

const COLUMNS = 'a.id, a.user_id, a.warehouse_id, a.assigned_by, a.created_at';
const JOIN = 'JOIN warehouses w ON w.id = a.warehouse_id';

export async function create(db, { user_id, warehouse_id, assigned_by = null }) {
  const [result] = await db.execute(
    'INSERT INTO user_warehouse_assignments (user_id, warehouse_id, assigned_by) VALUES (?, ?, ?)',
    [user_id, warehouse_id, assigned_by]
  );
  return findById(db, result.insertId);
}

// Carries w.bu_id along (the warehouse's own bu_id, via the join) so callers
// can run it through assertRowInScope() the same way items/contacts do.
export async function findById(db, id) {
  const [rows] = await db.execute(
    `SELECT ${COLUMNS}, w.bu_id FROM user_warehouse_assignments a ${JOIN} WHERE a.id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findByUserAndWarehouse(db, userId, warehouseId) {
  const [rows] = await db.execute(
    'SELECT id FROM user_warehouse_assignments WHERE user_id = ? AND warehouse_id = ?',
    [userId, warehouseId]
  );
  return rows[0] ?? null;
}

function buildFilter({ userId, warehouseId, buIds }) {
  const conditions = [];
  const params = [];
  if (userId) {
    conditions.push('a.user_id = ?');
    params.push(userId);
  }
  if (warehouseId) {
    conditions.push('a.warehouse_id = ?');
    params.push(warehouseId);
  }
  // w.bu_id is available directly here (joined), so directBuIdsCondition
  // (not the subquery form) is the right one, same idea as warehouses.repository.js.
  const bu = directBuIdsCondition('w.bu_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function findAll(db, { userId, warehouseId, buIds, limit, offset }) {
  const { clause, params } = buildFilter({ userId, warehouseId, buIds });
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM user_warehouse_assignments a ${JOIN} ${clause} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { userId, warehouseId, buIds }) {
  const { clause, params } = buildFilter({ userId, warehouseId, buIds });
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total FROM user_warehouse_assignments a ${JOIN} ${clause}`,
    params
  );
  return Number(rows[0].total);
}

export async function remove(db, id) {
  await db.execute('DELETE FROM user_warehouse_assignments WHERE id = ?', [id]);
}
