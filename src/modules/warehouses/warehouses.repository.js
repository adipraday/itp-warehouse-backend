import { directBuIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const COLUMNS = 'id, code, name, address, bu_id, parent_warehouse_id, created_by, created_at, updated_at';

// buIds null (super-admin, or no identity in hybrid/header mode) sees every
// warehouse; a scoped caller only sees warehouses in any of their business
// units (home BU + admin-bu grants, or every BU in an owner's company). Filters
// bu_id directly (this IS the warehouses table) — see directBuIdsCondition().
//
// assignedWarehouseIds further narrows to a staff user's own assigned
// warehouse(s) (docs/user-warehouse-assignments.md) — filters on `id` itself
// (not a `warehouse_id` column, since this table IS the warehouse), which is
// why assignedWarehouseCondition() is called with 'id' here specifically.
function buFilter(buIds, assignedWarehouseIds) {
  const conditions = [];
  const params = [];
  const bu = directBuIdsCondition('bu_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return conditions.length ? { clause: `WHERE ${conditions.join(' AND ')}`, params } : { clause: '', params: [] };
}

export async function findAll(db, { limit, offset, buIds = null, assignedWarehouseIds = null }) {
  const { clause, params } = buFilter(buIds, assignedWarehouseIds);
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM warehouses ${clause} ORDER BY id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, buIds = null, assignedWarehouseIds = null) {
  const { clause, params } = buFilter(buIds, assignedWarehouseIds);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM warehouses ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM warehouses WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByCode(db, code) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM warehouses WHERE code = ?`, [code]);
  return rows[0] ?? null;
}

export async function create(db, { code, name, address = null, bu_id = null, parent_warehouse_id = null }, createdBy = null) {
  const [result] = await db.execute(
    'INSERT INTO warehouses (code, name, address, bu_id, parent_warehouse_id, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [code, name, address, bu_id, parent_warehouse_id, createdBy]
  );
  return findById(db, result.insertId);
}

export async function update(db, id, { code, name, address = null, bu_id = null, parent_warehouse_id = null }) {
  await db.execute(
    `UPDATE warehouses SET code = ?, name = ?, address = ?, bu_id = ?, parent_warehouse_id = ?,
       updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [code, name, address, bu_id, parent_warehouse_id, id]
  );
  return findById(db, id);
}

export async function remove(db, id) {
  await db.execute('DELETE FROM warehouses WHERE id = ?', [id]);
}

// How many branch warehouses currently point at `id` as their main warehouse.
// Used to block delete/demote/bu_id-change on a warehouse that still has branches.
export async function countChildren(db, id) {
  const [rows] = await db.execute('SELECT COUNT(*) AS total FROM warehouses WHERE parent_warehouse_id = ?', [id]);
  return Number(rows[0].total);
}

// The existing main warehouse (parent_warehouse_id IS NULL) for a bu_id, if any,
// excluding `excludeId` itself (so updating a warehouse in place doesn't collide
// with its own pre-update row). Enforces "at most one main warehouse per BU".
export async function findMainWarehouseInBu(db, buId, excludeId = null) {
  const [rows] = await db.execute(
    'SELECT id FROM warehouses WHERE bu_id = ? AND parent_warehouse_id IS NULL AND id != ? LIMIT 1',
    [buId, excludeId ?? 0]
  );
  return rows[0] ?? null;
}

export async function findStocksByWarehouse(db, warehouseId, { limit, offset }) {
  const [rows] = await db.execute(
    `SELECT i.id AS item_id, i.sku, i.name, i.unit, s.quantity, i.min_stock, s.updated_at
     FROM stocks s
     JOIN items i ON i.id = s.item_id
     WHERE s.warehouse_id = ?
     ORDER BY i.name ASC
     LIMIT ? OFFSET ?`,
    [warehouseId, limit, offset]
  );
  return rows;
}

export async function countStocksByWarehouse(db, warehouseId) {
  const [rows] = await db.execute('SELECT COUNT(*) AS total FROM stocks WHERE warehouse_id = ?', [warehouseId]);
  return Number(rows[0].total);
}

export async function stockSummary(db, warehouseId) {
  const [rows] = await db.execute(
    `SELECT
       COUNT(*) AS total_items,
       COALESCE(SUM(s.quantity), 0) AS total_quantity,
       COALESCE(SUM(CASE WHEN s.quantity > 0 AND s.quantity <= i.min_stock THEN 1 ELSE 0 END), 0) AS low_stock_count,
       COALESCE(SUM(CASE WHEN s.quantity = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count
     FROM stocks s
     JOIN items i ON i.id = s.item_id
     WHERE s.warehouse_id = ?`,
    [warehouseId]
  );
  const row = rows[0];
  return {
    warehouse_id: Number(warehouseId),
    total_items: Number(row.total_items ?? 0),
    total_quantity: Number(row.total_quantity ?? 0),
    low_stock_count: Number(row.low_stock_count ?? 0),
    out_of_stock_count: Number(row.out_of_stock_count ?? 0)
  };
}
