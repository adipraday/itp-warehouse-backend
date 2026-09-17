import { directBuIdsCondition } from '../../shared/auth/bu-filter.js';

const COLUMNS = 'id, bu_id, sku, barcode, name, unit, min_stock, selling_price, created_by, created_at, updated_at';

function buFilter(buIds) {
  const bu = directBuIdsCondition('bu_id', buIds);
  return bu ? { clause: `WHERE ${bu.clause}`, params: bu.params } : { clause: '', params: [] };
}

export async function findAll(db, { limit, offset, buIds = null }) {
  const { clause, params } = buFilter(buIds);
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM items ${clause} ORDER BY id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, buIds = null) {
  const { clause, params } = buFilter(buIds);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM items ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM items WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

// SKU uniqueness is scoped per business unit (2026-09-14 fix — see the
// 202609140001 migration): two unrelated BUs may both use "SKU-001". `<=>` is
// MySQL's NULL-safe equality, so buId === null (an unassigned item) matches
// other unassigned rows without needing a separate branch.
export async function findBySkuInBu(db, sku, buId) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM items WHERE sku = ? AND bu_id <=> ?`, [sku, buId]);
  return rows[0] ?? null;
}

// Barcode uniqueness is scoped per business unit (2026-09-14 fix, same class
// as the sku fix — see the 202609140002 migration): two unrelated BUs may
// both register the same real-world product barcode. Used when we already
// know the ONE target bu_id (create/update conflict-checking).
export async function findByBarcodeInBu(db, barcode, buId) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM items WHERE barcode = ? AND bu_id <=> ?`, [barcode, buId]);
  return rows[0] ?? null;
}

// Exact-match lookup for a barcode scanner — deliberately `= ?`, not LIKE, so
// a scan resolves to one row instantly instead of a fuzzy list. Scoped to the
// caller's accessible BUs (an array, since admin-bu/owner may span more than
// one) rather than a single bu_id — necessary now that two different BUs can
// legitimately share the same barcode, so an unscoped lookup could otherwise
// return a completely unrelated business's item to whoever scanned first.
export async function findByBarcodeInBuIds(db, barcode, buIds) {
  const bu = directBuIdsCondition('bu_id', buIds);
  if (!bu) {
    const [rows] = await db.execute(`SELECT ${COLUMNS} FROM items WHERE barcode = ?`, [barcode]);
    return rows[0] ?? null;
  }
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM items WHERE barcode = ? AND ${bu.clause}`, [
    barcode,
    ...bu.params
  ]);
  return rows[0] ?? null;
}

export async function create(
  db,
  { sku, barcode = null, name, unit, min_stock = 0, selling_price = 0, bu_id = null },
  createdBy = null
) {
  const [result] = await db.execute(
    'INSERT INTO items (sku, barcode, name, unit, min_stock, selling_price, bu_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [sku, barcode, name, unit, min_stock, selling_price, bu_id, createdBy]
  );
  return findById(db, result.insertId);
}

export async function update(
  db,
  id,
  { sku, barcode = null, name, unit, min_stock = 0, selling_price = 0, bu_id = null }
) {
  await db.execute(
    'UPDATE items SET sku = ?, barcode = ?, name = ?, unit = ?, min_stock = ?, selling_price = ?, bu_id = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
    [sku, barcode, name, unit, min_stock, selling_price, bu_id, id]
  );
  return findById(db, id);
}

export async function search(db, q, { limit, offset, buIds = null }) {
  const like = `%${q}%`;
  const bu = directBuIdsCondition('bu_id', buIds);
  const conditions = ['(sku LIKE ? OR name LIKE ? OR barcode LIKE ?)'];
  const params = [like, like, like];
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  params.push(limit, offset);
  const [rows] = await db.execute(
    `SELECT ${COLUMNS}
     FROM items
     WHERE ${conditions.join(' AND ')}
     ORDER BY name ASC
     LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

export async function countSearch(db, q, buIds = null) {
  const like = `%${q}%`;
  const bu = directBuIdsCondition('bu_id', buIds);
  const conditions = ['(sku LIKE ? OR name LIKE ? OR barcode LIKE ?)'];
  const params = [like, like, like];
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total FROM items WHERE ${conditions.join(' AND ')}`,
    params
  );
  return Number(rows[0].total);
}

// All of a BU's items with their stock at ONE specific warehouse (0 if the
// item has no stock row there yet) — the data source for the per-warehouse
// item export (2026-09-14). LEFT JOIN, not JOIN, so an item with zero stock
// anywhere still appears (COALESCE'd to 0) rather than silently vanishing.
export async function findAllWithStockAtWarehouse(db, warehouseId, buIds = null) {
  const bu = directBuIdsCondition('i.bu_id', buIds);
  const whereClause = bu ? `WHERE ${bu.clause}` : '';
  const [rows] = await db.execute(
    `SELECT i.id, i.sku, i.barcode, i.name, i.unit, i.min_stock, i.selling_price,
            COALESCE(s.quantity, 0) AS quantity
     FROM items i
     LEFT JOIN stocks s ON s.item_id = i.id AND s.warehouse_id = ?
     ${whereClause}
     ORDER BY i.name ASC`,
    [warehouseId, ...(bu ? bu.params : [])]
  );
  return rows;
}

export async function findStocksByItem(db, itemId, { warehouseId, limit, offset }) {
  const params = [itemId];
  let filter = '';
  if (warehouseId) {
    filter = ' AND s.warehouse_id = ?';
    params.push(warehouseId);
  }
  params.push(limit, offset);
  const [rows] = await db.execute(
    `SELECT w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, s.quantity, s.updated_at
     FROM stocks s
     JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.item_id = ?${filter}
     ORDER BY w.name ASC
     LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

export async function countStocksByItem(db, itemId, warehouseId) {
  const params = [itemId];
  let filter = '';
  if (warehouseId) {
    filter = ' AND warehouse_id = ?';
    params.push(warehouseId);
  }
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM stocks WHERE item_id = ?${filter}`, params);
  return Number(rows[0].total);
}

export async function costSummary(db, itemId, warehouseId) {
  const [rows] = await db.execute(
    `SELECT
       COALESCE(SUM(quantity_remaining), 0) AS quantity_remaining,
       COALESCE(SUM(quantity_remaining * unit_cost), 0) AS total_value
     FROM inventory_cost_layers
     WHERE item_id = ? AND warehouse_id = ? AND quantity_remaining > 0`,
    [itemId, warehouseId]
  );
  const row = rows[0];
  const quantityRemaining = Number(row.quantity_remaining ?? 0);
  const totalValue = Number(row.total_value ?? 0);
  const averageCost = quantityRemaining > 0 ? totalValue / quantityRemaining : 0;
  return {
    item_id: Number(itemId),
    warehouse_id: Number(warehouseId),
    quantity_remaining: quantityRemaining,
    total_value: totalValue.toFixed(2),
    average_unit_cost: averageCost.toFixed(2)
  };
}

export async function findCostHistory(db, itemId, warehouseId, { limit, offset }) {
  const [rows] = await db.execute(
    `SELECT id, quantity_received, quantity_remaining, unit_cost, origin_cost_layer_id, created_at
     FROM inventory_cost_layers
     WHERE item_id = ? AND warehouse_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT ? OFFSET ?`,
    [itemId, warehouseId, limit, offset]
  );
  return rows;
}

export async function countCostHistory(db, itemId, warehouseId) {
  const [rows] = await db.execute(
    'SELECT COUNT(*) AS total FROM inventory_cost_layers WHERE item_id = ? AND warehouse_id = ?',
    [itemId, warehouseId]
  );
  return Number(rows[0].total);
}
