import { randomUUID } from 'node:crypto';
import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const HEADER_COLUMNS = `id, return_number, warehouse_id, contact_id, type,
       original_invoice_id, original_inventory_transaction_id, replacement_inventory_transaction_id,
       status, reversal_of_return_id, reversal_reason, return_date, reason,
       created_by, approved_by, completed_by, approved_at, completed_at, cancelled_at, created_at, updated_at`;

// buIds scopes results to warehouses owned by any of the caller's business units.
function buildFilter({ warehouseId, type, status, buIds, assignedWarehouseIds }) {
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
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function findAll(db, { warehouseId, type, status, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ warehouseId, type, status, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM item_returns ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { warehouseId, type, status, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ warehouseId, type, status, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM item_returns ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${HEADER_COLUMNS} FROM item_returns WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByIdForUpdate(connection, id) {
  const [rows] = await connection.execute(`SELECT ${HEADER_COLUMNS} FROM item_returns WHERE id = ? FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

export async function findDetails(db, returnId) {
  const [rows] = await db.execute(
    `SELECT d.id, d.item_id, i.sku, i.name, d.quantity, d.condition, d.action, d.unit_cost, d.total_cost
     FROM item_return_details d
     JOIN items i ON i.id = d.item_id
     WHERE d.return_id = ?
     ORDER BY d.item_id ASC`,
    [returnId]
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
  contact_id,
  type,
  original_invoice_id = null,
  original_inventory_transaction_id = null,
  return_date,
  reason = null,
  reversal_of_return_id = null,
  reversal_reason = null
}, createdBy = null) {
  const [result] = await connection.execute(
    `INSERT INTO item_returns
       (return_number, warehouse_id, contact_id, type, original_invoice_id, original_inventory_transaction_id,
        status, return_date, reason, reversal_of_return_id, reversal_reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    [
      `TEMP-${randomUUID()}`,
      warehouse_id,
      contact_id,
      type,
      original_invoice_id,
      original_inventory_transaction_id,
      return_date,
      reason,
      reversal_of_return_id,
      reversal_reason,
      createdBy
    ]
  );
  const id = result.insertId;
  await connection.execute('UPDATE item_returns SET return_number = ? WHERE id = ?', [`RET-${String(id).padStart(6, '0')}`, id]);
  return id;
}

// unit_cost is always backend-derived (see returns.service.js), never a client value.
export async function insertDetails(connection, returnId, details) {
  for (const detail of details) {
    await connection.execute(
      'INSERT INTO item_return_details (return_id, item_id, quantity, `condition`, action, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
      [returnId, detail.item_id, detail.quantity, detail.condition, detail.action, detail.unit_cost]
    );
  }
}

export async function replaceDetails(connection, returnId, details) {
  await connection.execute('DELETE FROM item_return_details WHERE return_id = ?', [returnId]);
  await insertDetails(connection, returnId, details);
}

export async function updateHeader(connection, id, { warehouse_id, contact_id, return_date, reason = null }) {
  await connection.execute(
    `UPDATE item_returns SET warehouse_id = ?, contact_id = ?, return_date = ?, reason = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [warehouse_id, contact_id, return_date, reason, id]
  );
}

export async function remove(db, id) {
  await db.execute('DELETE FROM item_returns WHERE id = ?', [id]);
}

export async function markApproved(db, id, approvedBy = null) {
  await db.execute(
    `UPDATE item_returns SET status = 'APPROVED', approved_by = ?, approved_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'DRAFT'`,
    [approvedBy, id]
  );
}

export async function markCompleted(connection, id, replacementTransactionId, completedBy = null) {
  await connection.execute(
    `UPDATE item_returns
     SET status = 'COMPLETED', replacement_inventory_transaction_id = ?, completed_by = ?, completed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [replacementTransactionId, completedBy, id]
  );
}

export async function markRejected(db, id) {
  await db.execute(
    `UPDATE item_returns SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status IN ('DRAFT', 'APPROVED')`,
    [id]
  );
}

export async function markCancelled(db, id) {
  await db.execute(
    `UPDATE item_returns SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status IN ('DRAFT', 'APPROVED')`,
    [id]
  );
}

// The historical cost basis for a return line: a SALES invoice's frozen HPP,
// or a supplier INBOUND's received unit price.
export async function findInvoiceLine(db, invoiceId, itemId) {
  const [rows] = await db.execute('SELECT quantity, unit_cost FROM invoice_details WHERE invoice_id = ? AND item_id = ?', [
    invoiceId,
    itemId
  ]);
  return rows[0] ?? null;
}

export async function findTransactionLine(db, transactionId, itemId) {
  const [rows] = await db.execute(
    'SELECT quantity, unit_price FROM inventory_transaction_details WHERE transaction_id = ? AND item_id = ?',
    [transactionId, itemId]
  );
  return rows[0] ?? null;
}

export async function sumReturnedQuantityForInvoice(db, invoiceId, itemId) {
  const [rows] = await db.execute(
    `SELECT COALESCE(SUM(d.quantity), 0) AS total
     FROM item_return_details d JOIN item_returns r ON r.id = d.return_id
     WHERE r.original_invoice_id = ? AND d.item_id = ? AND r.status = 'COMPLETED'`,
    [invoiceId, itemId]
  );
  return Number(rows[0].total ?? 0);
}

export async function sumReturnedQuantityForTransaction(db, transactionId, itemId) {
  const [rows] = await db.execute(
    `SELECT COALESCE(SUM(d.quantity), 0) AS total
     FROM item_return_details d JOIN item_returns r ON r.id = d.return_id
     WHERE r.original_inventory_transaction_id = ? AND d.item_id = ? AND r.status = 'COMPLETED'`,
    [transactionId, itemId]
  );
  return Number(rows[0].total ?? 0);
}
