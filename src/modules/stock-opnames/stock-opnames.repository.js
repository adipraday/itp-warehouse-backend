import { randomUUID } from 'node:crypto';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const HEADER_COLUMNS = `id, opname_number, warehouse_id, opname_date, status,
       reversal_of_stock_opname_id, reversal_reason, notes,
       created_by, approved_by, submitted_at, approved_at, cancelled_at, created_at, updated_at`;

// buIds scopes results to warehouses owned by any of the caller's business units.
function buildFilter({ warehouseId, status, buIds, assignedWarehouseIds }) {
  const conditions = [];
  const params = [];
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
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
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function findAll(db, { warehouseId, status, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ warehouseId, status, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM stock_opnames ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { warehouseId, status, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ warehouseId, status, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM stock_opnames ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${HEADER_COLUMNS} FROM stock_opnames WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByIdForUpdate(connection, id) {
  const [rows] = await connection.execute(`SELECT ${HEADER_COLUMNS} FROM stock_opnames WHERE id = ? FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

export async function findDetails(db, opnameId) {
  const [rows] = await db.execute(
    `SELECT d.id, d.item_id, i.sku, i.name, d.system_qty, d.physical_qty, d.difference, d.notes
     FROM stock_opname_details d
     JOIN items i ON i.id = d.item_id
     WHERE d.stock_opname_id = ?
     ORDER BY d.item_id ASC`,
    [opnameId]
  );
  return rows;
}

export async function findByIdWithDetails(db, id) {
  const header = await findById(db, id);
  if (!header) return null;
  header.details = await findDetails(db, id);
  return header;
}

export async function insertHeader(connection, { warehouse_id, opname_date, notes = null }, createdBy = null) {
  const [result] = await connection.execute(
    `INSERT INTO stock_opnames (opname_number, warehouse_id, status, opname_date, notes, created_by)
     VALUES (?, ?, 'DRAFT', ?, ?, ?)`,
    [`TEMP-${randomUUID()}`, warehouse_id, opname_date, notes, createdBy]
  );
  const id = result.insertId;
  await connection.execute('UPDATE stock_opnames SET opname_number = ? WHERE id = ?', [
    `OPN-${String(id).padStart(6, '0')}`,
    id
  ]);
  return id;
}

// Snapshots the current stocks.quantity as each line's system_qty at insert
// time; that snapshot is the evidence approval later adjusts against.
export async function insertDetails(connection, opnameId, warehouseId, details) {
  for (const detail of details) {
    await stocksRepository.ensureRow(connection, warehouseId, detail.item_id);
    const systemQty = await stocksRepository.getQuantity(connection, warehouseId, detail.item_id);
    await connection.execute(
      `INSERT INTO stock_opname_details (stock_opname_id, item_id, system_qty, physical_qty, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [opnameId, detail.item_id, systemQty, detail.physical_qty, detail.notes ?? null]
    );
  }
}

export async function replaceDetails(connection, opnameId, warehouseId, details) {
  await connection.execute('DELETE FROM stock_opname_details WHERE stock_opname_id = ?', [opnameId]);
  await insertDetails(connection, opnameId, warehouseId, details);
}

export async function updateHeader(connection, id, { warehouse_id, opname_date, notes = null }) {
  await connection.execute(
    `UPDATE stock_opnames SET warehouse_id = ?, opname_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [warehouse_id, opname_date, notes, id]
  );
}

export async function remove(db, id) {
  await db.execute('DELETE FROM stock_opnames WHERE id = ?', [id]);
}

export async function markSubmitted(db, id) {
  await db.execute(
    `UPDATE stock_opnames SET status = 'SUBMITTED', submitted_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'DRAFT'`,
    [id]
  );
}

export async function markApproved(connection, id, approvedBy = null) {
  await connection.execute(
    `UPDATE stock_opnames SET status = 'APPROVED', approved_by = ?, approved_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [approvedBy, id]
  );
}

export async function markCancelled(db, id) {
  await db.execute(
    `UPDATE stock_opnames SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status IN ('DRAFT', 'SUBMITTED')`,
    [id]
  );
}
