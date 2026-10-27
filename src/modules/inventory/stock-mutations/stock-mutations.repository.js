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
    conditions.push('m.warehouse_id = ?');
    params.push(query.warehouseId);
  }
  if (query.itemId) {
    conditions.push('m.item_id = ?');
    params.push(query.itemId);
  }
  if (query.type) {
    conditions.push('m.type = ?');
    params.push(query.type);
  }
  if (query.direction) {
    conditions.push('m.direction = ?');
    params.push(query.direction);
  }
  if (query.sourceType) {
    conditions.push('m.source_type = ?');
    params.push(query.sourceType);
  }
  if (query.sourceId) {
    conditions.push('m.source_id = ?');
    params.push(query.sourceId);
  }
  if (query.from) {
    conditions.push('m.occurred_at >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (query.to) {
    conditions.push('m.occurred_at <= ?');
    params.push(`${query.to} 23:59:59`);
  }
  const bu = buIdsCondition('m.warehouse_id', query.buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('m.warehouse_id', query.assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

// Item and warehouse names ride along so a ledger row is readable without a lookup per row.
const SELECT_FROM = `SELECT m.id, m.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
       m.item_id, i.sku AS item_sku, i.name AS item_name, i.unit AS item_unit,
       m.type, m.direction, m.quantity, m.total_cost,
       m.source_type, m.source_id, m.inventory_transaction_id, m.return_id, m.stock_opname_id,
       m.stock_transfer_id, m.occurred_at, m.created_at
     FROM stock_mutations m
     LEFT JOIN items i ON i.id = m.item_id
     LEFT JOIN warehouses w ON w.id = m.warehouse_id`;

export async function findAll(db, query, { limit, offset }) {
  const { clause, params } = buildFilter(query);
  const [rows] = await db.execute(
    `${SELECT_FROM} ${clause} ORDER BY m.occurred_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, query) {
  const { clause, params } = buildFilter(query);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM stock_mutations m ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`${SELECT_FROM} WHERE m.id = ?`, [id]);
  return rows[0] ?? null;
}
