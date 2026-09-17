import { randomUUID } from 'node:crypto';
import { buIdsCondition, assignedWarehouseCondition } from '../../../shared/auth/bu-filter.js';

const TYPE = 'INBOUND';

// buIds scopes results to warehouses owned by any of the caller's business
// units (null for super-admin / no identity in hybrid mode — see everything).
function buildFilter({ warehouseId, status, from, to, buIds, assignedWarehouseIds }) {
  const conditions = ['type = ?'];
  const params = [TYPE];
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
  if (from) {
    conditions.push('transaction_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('transaction_date <= ?');
    params.push(to);
  }
  return { clause: conditions.join(' AND '), params };
}

const HEADER_COLUMNS = `id, transaction_number, warehouse_id, contact_id, type, status,
       reversal_of_transaction_id, reversal_reason, transaction_date, notes,
       created_by, completed_by, completed_at, cancelled_at, created_at, updated_at`;

export async function findAll(db, { warehouseId, status, from, to, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ warehouseId, status, from, to, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM inventory_transactions WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { warehouseId, status, from, to, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ warehouseId, status, from, to, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM inventory_transactions WHERE ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM inventory_transactions WHERE id = ? AND type = ?`,
    [id, TYPE]
  );
  return rows[0] ?? null;
}

export async function findByIdForUpdate(connection, id) {
  const [rows] = await connection.execute(
    `SELECT ${HEADER_COLUMNS} FROM inventory_transactions WHERE id = ? AND type = ? FOR UPDATE`,
    [id, TYPE]
  );
  return rows[0] ?? null;
}

// Used to validate a reversal target, which may be the opposite document type.
export async function findAnyById(db, id) {
  const [rows] = await db.execute('SELECT id, type, status FROM inventory_transactions WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function findDetails(db, transactionId) {
  const [rows] = await db.execute(
    `SELECT d.id, d.item_id, i.sku, i.name, d.quantity, d.unit_price, d.total_price
     FROM inventory_transaction_details d
     JOIN items i ON i.id = d.item_id
     WHERE d.transaction_id = ?
     ORDER BY d.item_id ASC`,
    [transactionId]
  );
  return rows;
}

export async function findByIdWithDetails(db, id) {
  const header = await findById(db, id);
  if (!header) return null;
  header.details = await findDetails(db, id);
  return header;
}

export async function insertHeader(connection, {
  warehouse_id,
  contact_id = null,
  transaction_date,
  notes = null,
  reversal_of_transaction_id = null,
  reversal_reason = null
}, createdBy = null) {
  const [result] = await connection.execute(
    `INSERT INTO inventory_transactions
       (transaction_number, warehouse_id, contact_id, type, status, transaction_date, notes,
        reversal_of_transaction_id, reversal_reason, created_by)
     VALUES (?, ?, ?, 'INBOUND', 'DRAFT', ?, ?, ?, ?, ?)`,
    [`TEMP-${randomUUID()}`, warehouse_id, contact_id, transaction_date, notes, reversal_of_transaction_id, reversal_reason, createdBy]
  );
  const id = result.insertId;
  await connection.execute('UPDATE inventory_transactions SET transaction_number = ? WHERE id = ?', [
    `IN-${String(id).padStart(6, '0')}`,
    id
  ]);
  return id;
}

export async function insertDetails(connection, transactionId, details) {
  for (const detail of details) {
    await connection.execute(
      'INSERT INTO inventory_transaction_details (transaction_id, item_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
      [transactionId, detail.item_id, detail.quantity, detail.unit_price ?? 0]
    );
  }
}

export async function replaceDetails(connection, transactionId, details) {
  await connection.execute('DELETE FROM inventory_transaction_details WHERE transaction_id = ?', [transactionId]);
  await insertDetails(connection, transactionId, details);
}

export async function updateHeader(connection, id, { warehouse_id, contact_id = null, transaction_date, notes = null }) {
  await connection.execute(
    `UPDATE inventory_transactions
     SET warehouse_id = ?, contact_id = ?, transaction_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [warehouse_id, contact_id, transaction_date, notes, id]
  );
}

export async function remove(db, id) {
  await db.execute('DELETE FROM inventory_transactions WHERE id = ? AND type = ?', [id, TYPE]);
}

export async function markCompleted(connection, id, completedBy = null) {
  await connection.execute(
    `UPDATE inventory_transactions
     SET status = 'COMPLETED', completed_by = ?, completed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [completedBy, id]
  );
}

export async function markCancelled(db, id) {
  await db.execute(
    `UPDATE inventory_transactions
     SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'DRAFT'`,
    [id]
  );
}
