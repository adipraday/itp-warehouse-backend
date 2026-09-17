// Used internally by inbound/outbound completion to get-or-create then lock a
// stocks row before mutating it, per the guide's concurrency-safe upsert pattern.
export async function ensureRow(connection, warehouseId, itemId) {
  await connection.execute(
    `INSERT INTO stocks (warehouse_id, item_id, quantity) VALUES (?, ?, 0)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [warehouseId, itemId]
  );
}

export async function lockRow(connection, warehouseId, itemId) {
  const [rows] = await connection.execute(
    'SELECT id, warehouse_id, item_id, quantity FROM stocks WHERE warehouse_id = ? AND item_id = ? FOR UPDATE',
    [warehouseId, itemId]
  );
  return rows[0];
}

// Unlocked read used to snapshot a quantity for record-keeping (e.g. a stock
// opname's system_qty) where transactional consistency with a later write isn't required.
export async function getQuantity(db, warehouseId, itemId) {
  const [rows] = await db.execute('SELECT quantity FROM stocks WHERE warehouse_id = ? AND item_id = ?', [
    warehouseId,
    itemId
  ]);
  return rows[0]?.quantity ?? 0;
}

export async function increment(connection, warehouseId, itemId, delta) {
  await connection.execute(
    'UPDATE stocks SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP(3) WHERE warehouse_id = ? AND item_id = ?',
    [delta, warehouseId, itemId]
  );
}

export async function decrement(connection, warehouseId, itemId, delta) {
  await connection.execute(
    'UPDATE stocks SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP(3) WHERE warehouse_id = ? AND item_id = ?',
    [delta, warehouseId, itemId]
  );
}

import { buIdsCondition, assignedWarehouseCondition } from '../../../shared/auth/bu-filter.js';

function buildFilter({ warehouseId, itemId, buIds, assignedWarehouseIds }) {
  const conditions = [];
  const params = [];
  if (warehouseId) {
    conditions.push('s.warehouse_id = ?');
    params.push(warehouseId);
  }
  if (itemId) {
    conditions.push('s.item_id = ?');
    params.push(itemId);
  }
  const bu = buIdsCondition('s.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('s.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

const SELECT_COLUMNS = `s.id, s.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
       s.item_id, i.sku, i.name AS item_name, i.unit, i.min_stock, s.quantity, s.updated_at`;
const JOINS = 'JOIN warehouses w ON w.id = s.warehouse_id JOIN items i ON i.id = s.item_id';

export async function findAll(db, { warehouseId, itemId, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ warehouseId, itemId, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${SELECT_COLUMNS} FROM stocks s ${JOINS} ${clause} ORDER BY s.id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { warehouseId, itemId, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ warehouseId, itemId, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM stocks s ${clause}`, params);
  return Number(rows[0].total);
}

export async function findLowStock(db, { warehouseId, buIds, assignedWarehouseIds, limit, offset }) {
  const conditions = ['s.quantity > 0', 's.quantity <= i.min_stock'];
  const params = [];
  if (warehouseId) {
    conditions.push('s.warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('s.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('s.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  params.push(limit, offset);
  const [rows] = await db.execute(
    `SELECT ${SELECT_COLUMNS} FROM stocks s ${JOINS} WHERE ${conditions.join(' AND ')} ORDER BY s.quantity ASC LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

export async function countLowStock(db, { warehouseId, buIds, assignedWarehouseIds }) {
  const conditions = ['s.quantity > 0', 's.quantity <= i.min_stock'];
  const params = [];
  if (warehouseId) {
    conditions.push('s.warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('s.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('s.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total FROM stocks s JOIN items i ON i.id = s.item_id WHERE ${conditions.join(' AND ')}`,
    params
  );
  return Number(rows[0].total);
}

export async function findOutOfStock(db, { warehouseId, buIds, assignedWarehouseIds, limit, offset }) {
  const conditions = ['s.quantity = 0'];
  const params = [];
  if (warehouseId) {
    conditions.push('s.warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('s.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('s.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  params.push(limit, offset);
  const [rows] = await db.execute(
    `SELECT ${SELECT_COLUMNS} FROM stocks s ${JOINS} WHERE ${conditions.join(' AND ')} ORDER BY i.name ASC LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

export async function countOutOfStock(db, { warehouseId, buIds, assignedWarehouseIds }) {
  const conditions = ['s.quantity = 0'];
  const params = [];
  if (warehouseId) {
    conditions.push('s.warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('s.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('s.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total FROM stocks s WHERE ${conditions.join(' AND ')}`,
    params
  );
  return Number(rows[0].total);
}
