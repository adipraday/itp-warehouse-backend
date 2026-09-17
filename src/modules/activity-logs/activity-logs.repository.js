import { directBuIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

// Written by the global activity-log hook in app.js on every successful
// mutating request — see src/shared/activity-log/log-hook.js.
export async function create(db, {
  user_id,
  warehouse_id,
  bu_id = null,
  action,
  entity_type,
  entity_id,
  method,
  endpoint,
  status_code,
  metadata = null
}) {
  await db.execute(
    `INSERT INTO activity_logs
       (user_id, warehouse_id, bu_id, action, entity_type, entity_id, method, endpoint, status_code, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user_id,
      warehouse_id,
      bu_id,
      action,
      entity_type,
      entity_id,
      method,
      endpoint,
      status_code,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

function buildFilter({ userId, warehouseId, entityType, entityId, action, from, to, buIds, assignedWarehouseIds }) {
  const conditions = [];
  const params = [];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
  }
  if (entityType) {
    conditions.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId) {
    conditions.push('entity_id = ?');
    params.push(entityId);
  }
  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (from) {
    conditions.push('created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    conditions.push('created_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  const bu = directBuIdsCondition('bu_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

const COLUMNS = 'id, user_id, warehouse_id, bu_id, action, entity_type, entity_id, method, endpoint, status_code, metadata, created_at';

function parseRow(row) {
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}

export async function findAll(db, filter, { limit, offset }) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM activity_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows.map(parseRow);
}

export async function count(db, filter) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM activity_logs ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM activity_logs WHERE id = ?`, [id]);
  return rows[0] ? parseRow(rows[0]) : null;
}
