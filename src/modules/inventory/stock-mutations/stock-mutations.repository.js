import { buIdsCondition, assignedWarehouseCondition } from '../../../shared/auth/bu-filter.js';

// Written internally by inbound/outbound (and later transfer/return/opname) completion.
export async function create(connection, {
  warehouse_id,
  item_id,
  type,
  direction,
  quantity,
  total_cost,
  source_type,
  source_id,
  inventory_transaction_id = null,
  return_id = null,
  stock_opname_id = null,
  stock_transfer_id = null
}) {
  const [result] = await connection.execute(
    `INSERT INTO stock_mutations
       (warehouse_id, item_id, type, direction, quantity, total_cost, source_type, source_id,
        inventory_transaction_id, return_id, stock_opname_id, stock_transfer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      warehouse_id,
      item_id,
      type,
      direction,
      quantity,
      total_cost,
      source_type,
      source_id,
      inventory_transaction_id,
      return_id,
      stock_opname_id,
      stock_transfer_id
    ]
  );
  return result.insertId;
}

function buildFilter(query) {
  const conditions = [];
  const params = [];
  if (query.warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(query.warehouseId);
  }
  if (query.itemId) {
    conditions.push('item_id = ?');
    params.push(query.itemId);
  }
  if (query.type) {
    conditions.push('type = ?');
    params.push(query.type);
  }
  if (query.direction) {
    conditions.push('direction = ?');
    params.push(query.direction);
  }
  if (query.sourceType) {
    conditions.push('source_type = ?');
    params.push(query.sourceType);
  }
  if (query.sourceId) {
    conditions.push('source_id = ?');
    params.push(query.sourceId);
  }
  if (query.from) {
    conditions.push('occurred_at >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (query.to) {
    conditions.push('occurred_at <= ?');
    params.push(`${query.to} 23:59:59`);
  }
  const bu = buIdsCondition('warehouse_id', query.buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('warehouse_id', query.assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

const SELECT_COLUMNS = `id, warehouse_id, item_id, type, direction, quantity, total_cost,
       source_type, source_id, inventory_transaction_id, return_id, stock_opname_id,
       stock_transfer_id, occurred_at, created_at`;

export async function findAll(db, query, { limit, offset }) {
  const { clause, params } = buildFilter(query);
  const [rows] = await db.execute(
    `SELECT ${SELECT_COLUMNS} FROM stock_mutations ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, query) {
  const { clause, params } = buildFilter(query);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM stock_mutations ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${SELECT_COLUMNS} FROM stock_mutations WHERE id = ?`, [id]);
  return rows[0] ?? null;
}
