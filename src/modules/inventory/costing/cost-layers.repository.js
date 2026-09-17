import { buIdsCondition, assignedWarehouseCondition } from '../../../shared/auth/bu-filter.js';

export async function create(connection, {
  warehouse_id,
  item_id,
  source_stock_mutation_id,
  origin_cost_layer_id = null,
  quantity_received,
  quantity_remaining,
  unit_cost
}) {
  const [result] = await connection.execute(
    `INSERT INTO inventory_cost_layers
       (warehouse_id, item_id, source_stock_mutation_id, origin_cost_layer_id, quantity_received, quantity_remaining, unit_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [warehouse_id, item_id, source_stock_mutation_id, origin_cost_layer_id, quantity_received, quantity_remaining, unit_cost]
  );
  return result.insertId;
}

// FIFO order, locked for the duration of the enclosing transaction so concurrent
// stock-outs cannot double-allocate the same remaining quantity.
export async function lockAvailableLayers(connection, warehouseId, itemId) {
  const [rows] = await connection.execute(
    `SELECT id, quantity_remaining, unit_cost
     FROM inventory_cost_layers
     WHERE warehouse_id = ? AND item_id = ? AND quantity_remaining > 0
     ORDER BY created_at ASC, id ASC
     FOR UPDATE`,
    [warehouseId, itemId]
  );
  return rows;
}

export async function consume(connection, layerId, quantity) {
  await connection.execute(
    'UPDATE inventory_cost_layers SET quantity_remaining = quantity_remaining - ? WHERE id = ?',
    [quantity, layerId]
  );
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
  if (query.remainingOnly) {
    conditions.push('quantity_remaining > 0');
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

const SELECT_COLUMNS = `id, warehouse_id, item_id, source_stock_mutation_id, origin_cost_layer_id,
       quantity_received, quantity_remaining, unit_cost, created_at`;

export async function findAll(db, query, { limit, offset }) {
  const { clause, params } = buildFilter(query);
  const [rows] = await db.execute(
    `SELECT ${SELECT_COLUMNS} FROM inventory_cost_layers ${clause} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, query) {
  const { clause, params } = buildFilter(query);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM inventory_cost_layers ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${SELECT_COLUMNS} FROM inventory_cost_layers WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function summary(db, { warehouseId, from, to, buIds, assignedWarehouseIds }) {
  const conditions = ['quantity_remaining > 0'];
  const params = [];
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
  }
  if (from) {
    conditions.push('created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    conditions.push('created_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  const bu = buIdsCondition('warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }

  const [rows] = await db.execute(
    `SELECT COALESCE(SUM(quantity_remaining), 0) AS quantity_remaining,
            COALESCE(SUM(quantity_remaining * unit_cost), 0) AS total_value
     FROM inventory_cost_layers
     WHERE ${conditions.join(' AND ')}`,
    params
  );
  const row = rows[0];
  return {
    quantity_remaining: Number(row.quantity_remaining ?? 0),
    total_value: Number(row.total_value ?? 0).toFixed(2)
  };
}
