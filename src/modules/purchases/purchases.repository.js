import { randomUUID } from 'node:crypto';
import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const TYPE = 'PURCHASE';

const BASE_COLUMNS = `id, invoice_number, warehouse_id, contact_id, type, status, receipt_status,
       reversal_of_invoice_id, reversal_reason, inventory_transaction_id,
       invoice_date, due_date, subtotal, tax, tax_rate, total_amount, payment_status, notes,
       supplier_invoice_number, supplier_invoice_file_name, supplier_invoice_file_size,
       supplier_invoice_uploaded_at, (supplier_invoice_file_key IS NOT NULL) AS has_supplier_invoice_file,
       cancel_reason, submitted_at, submitted_by,
       created_by, completed_by, completed_at, cancelled_at, created_at, updated_at`;

// paid_amount / refunded_amount are what the refund-due maths and the UI need; refund_due itself is
// derived in withRefundDue() so the formula lives in one place.
const HEADER_COLUMNS = `${BASE_COLUMNS},
       (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.invoice_id = invoices.id) AS paid_amount,
       (SELECT COALESCE(SUM(r.amount), 0) FROM purchase_refunds r WHERE r.invoice_id = invoices.id) AS refunded_amount`;

// Money the supplier still owes back: what was paid beyond what finally had to be paid (after lines
// were closed out, or the purchase was cancelled), minus refunds already recorded.
export function withRefundDue(row) {
  if (!row) return row;
  const paid = Number(row.paid_amount ?? 0);
  const total = Number(row.total_amount ?? 0);
  const refunded = Number(row.refunded_amount ?? 0);
  const due = Math.max(0, paid - total - refunded);
  return {
    ...row,
    has_supplier_invoice_file: Boolean(row.has_supplier_invoice_file),
    refund_due: due.toFixed(2)
  };
}

// buIds scopes results to warehouses owned by any of the caller's business units.
function buildFilter({ warehouseId, status, receiptStatus, buIds, assignedWarehouseIds }) {
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
  if (receiptStatus) {
    conditions.push('receipt_status = ?');
    params.push(receiptStatus);
  }
  return { clause: conditions.join(' AND '), params };
}

export async function findAll(db, { warehouseId, status, receiptStatus, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ warehouseId, status, receiptStatus, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM invoices WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows.map(withRefundDue);
}

export async function count(db, { warehouseId, status, receiptStatus, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ warehouseId, status, receiptStatus, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM invoices WHERE ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${HEADER_COLUMNS} FROM invoices WHERE id = ? AND type = ?`, [id, TYPE]);
  return withRefundDue(rows[0] ?? null);
}

export async function findByIdForUpdate(connection, id) {
  const [rows] = await connection.execute(`SELECT ${BASE_COLUMNS} FROM invoices WHERE id = ? AND type = ? FOR UPDATE`, [
    id,
    TYPE
  ]);
  return rows[0] ?? null;
}

// Used to validate a reversal target, which may be a SALES or PURCHASE invoice.
export async function findAnyById(db, id) {
  const [rows] = await db.execute('SELECT id, type, status FROM invoices WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function findDetails(db, invoiceId) {
  const [rows] = await db.execute(
    `SELECT d.id, d.item_id, i.sku, i.name, d.quantity, d.received_quantity, d.closed_quantity,
            d.unit_price, d.amount, d.unit_cost, d.cost_amount
     FROM invoice_details d
     JOIN items i ON i.id = d.item_id
     WHERE d.invoice_id = ?
     ORDER BY d.item_id ASC`,
    [invoiceId]
  );
  return rows;
}

export async function findDetailsForUpdate(connection, invoiceId) {
  const [rows] = await connection.execute(
    `SELECT id, item_id, quantity, received_quantity, closed_quantity, unit_price
     FROM invoice_details WHERE invoice_id = ? ORDER BY item_id ASC FOR UPDATE`,
    [invoiceId]
  );
  return rows;
}

export async function findReceipts(db, invoiceId) {
  const [rows] = await db.execute(
    `SELECT id, invoice_id, inventory_transaction_id, received_by, received_at, notes
     FROM purchase_receipts WHERE invoice_id = ? ORDER BY id ASC`,
    [invoiceId]
  );
  return rows;
}

export async function findRefunds(db, invoiceId) {
  const [rows] = await db.execute(
    `SELECT id, refund_number, invoice_id, amount, refund_method, refund_date, notes, created_by, created_at
     FROM purchase_refunds WHERE invoice_id = ? ORDER BY refund_date ASC, id ASC`,
    [invoiceId]
  );
  return rows;
}

export async function findByIdWithDetails(db, id) {
  const header = await findById(db, id);
  if (!header) return null;
  const [details, receipts, refunds] = await Promise.all([
    findDetails(db, id),
    findReceipts(db, id),
    findRefunds(db, id)
  ]);
  header.details = details;
  header.receipts = receipts;
  header.refunds = refunds;
  return header;
}

export async function sumPaid(db, invoiceId) {
  const [rows] = await db.execute('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = ?', [
    invoiceId
  ]);
  return Number(rows[0].total ?? 0);
}

export async function sumRefunded(connection, invoiceId) {
  const [rows] = await connection.execute(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM purchase_refunds WHERE invoice_id = ?',
    [invoiceId]
  );
  return Number(rows[0].total ?? 0);
}

export async function insertHeader(connection, {
  warehouse_id,
  contact_id = null,
  invoice_date,
  due_date = null,
  notes = null,
  tax_rate = 0,
  supplier_invoice_number = null,
  reversal_of_invoice_id = null,
  reversal_reason = null
}, createdBy = null) {
  const [result] = await connection.execute(
    `INSERT INTO invoices
       (invoice_number, warehouse_id, contact_id, type, status, invoice_date, due_date, notes, tax_rate,
        supplier_invoice_number, reversal_of_invoice_id, reversal_reason, created_by)
     VALUES (?, ?, ?, 'PURCHASE', 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `TEMP-${randomUUID()}`,
      warehouse_id,
      contact_id,
      invoice_date,
      due_date,
      notes,
      tax_rate,
      supplier_invoice_number,
      reversal_of_invoice_id,
      reversal_reason,
      createdBy
    ]
  );
  const id = result.insertId;
  await connection.execute('UPDATE invoices SET invoice_number = ? WHERE id = ?', [`PUR-${String(id).padStart(6, '0')}`, id]);
  return id;
}

export async function insertDetails(connection, invoiceId, details) {
  for (const detail of details) {
    await connection.execute(
      'INSERT INTO invoice_details (invoice_id, item_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
      [invoiceId, detail.item_id, detail.quantity, detail.unit_price ?? 0]
    );
  }
}

export async function replaceDetails(connection, invoiceId, details) {
  await connection.execute('DELETE FROM invoice_details WHERE invoice_id = ?', [invoiceId]);
  await insertDetails(connection, invoiceId, details);
}

export async function updateHeader(
  connection,
  id,
  { warehouse_id, contact_id = null, invoice_date, due_date = null, notes = null, tax_rate = 0, supplier_invoice_number = null }
) {
  await connection.execute(
    `UPDATE invoices SET warehouse_id = ?, contact_id = ?, invoice_date = ?, due_date = ?, notes = ?, tax_rate = ?,
       supplier_invoice_number = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [warehouse_id, contact_id, invoice_date, due_date, notes, tax_rate, supplier_invoice_number, id]
  );
}

// Totals follow what was finally bought: quantity minus the part closed out (never arriving, refunded).
// For an untouched purchase closed_quantity is 0, so this equals the plain sum it always was.
export async function computeAndStoreTotals(connection, invoiceId, taxRate) {
  const [rows] = await connection.execute(
    'SELECT COALESCE(SUM((quantity - closed_quantity) * unit_price), 0) AS subtotal FROM invoice_details WHERE invoice_id = ?',
    [invoiceId]
  );
  const subtotal = Number(rows[0].subtotal ?? 0);
  const tax = Number((subtotal * taxRate).toFixed(2));
  const totalAmount = Number((subtotal + tax).toFixed(2));

  await connection.execute('UPDATE invoices SET subtotal = ?, tax = ?, tax_rate = ?, total_amount = ? WHERE id = ?', [
    subtotal.toFixed(2),
    tax.toFixed(2),
    taxRate,
    totalAmount.toFixed(2),
    invoiceId
  ]);
  return totalAmount;
}

export async function remove(db, id) {
  await db.execute('DELETE FROM invoices WHERE id = ? AND type = ?', [id, TYPE]);
}

export async function markSubmitted(connection, id, userId = null) {
  await connection.execute(
    `UPDATE invoices
     SET receipt_status = 'PENDING_APPROVAL', submitted_at = CURRENT_TIMESTAMP(3), submitted_by = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [userId, id]
  );
}

export async function markPartiallyReceived(connection, id, inventoryTransactionId) {
  await connection.execute(
    `UPDATE invoices
     SET receipt_status = 'PARTIALLY_RECEIVED', inventory_transaction_id = COALESCE(inventory_transaction_id, ?),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [inventoryTransactionId, id]
  );
}

// inventoryTransactionId is the receipt just posted, or null when the purchase is closed without
// receiving anything more. The first receipt's transaction stays as the purchase's primary link.
export async function markCompleted(connection, id, inventoryTransactionId, completedBy = null) {
  await connection.execute(
    `UPDATE invoices
     SET status = 'COMPLETED', receipt_status = NULL, inventory_transaction_id = COALESCE(inventory_transaction_id, ?),
         completed_by = ?, completed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [inventoryTransactionId, completedBy, id]
  );
}

export async function insertReceipt(connection, { invoiceId, inventoryTransactionId, receivedBy = null, notes = null }) {
  const [result] = await connection.execute(
    'INSERT INTO purchase_receipts (invoice_id, inventory_transaction_id, received_by, notes) VALUES (?, ?, ?, ?)',
    [invoiceId, inventoryTransactionId, receivedBy, notes]
  );
  return result.insertId;
}

export async function addReceivedQuantity(connection, detailId, quantity) {
  await connection.execute('UPDATE invoice_details SET received_quantity = received_quantity + ? WHERE id = ?', [
    quantity,
    detailId
  ]);
}

export async function addClosedQuantity(connection, detailId, quantity) {
  await connection.execute('UPDATE invoice_details SET closed_quantity = closed_quantity + ? WHERE id = ?', [
    quantity,
    detailId
  ]);
}

export async function markCancelled(db, id, reason = null) {
  await db.execute(
    `UPDATE invoices
     SET status = 'CANCELLED', receipt_status = NULL, cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP(3),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'DRAFT'`,
    [reason, id]
  );
}

// A purchase closed out after goods were already received ends COMPLETED, not CANCELLED; the reason
// is still kept for the audit trail.
export async function setCancelReason(connection, id, reason) {
  await connection.execute('UPDATE invoices SET cancel_reason = ? WHERE id = ?', [reason, id]);
}

export async function setSupplierInvoiceNumber(db, id, number) {
  await db.execute('UPDATE invoices SET supplier_invoice_number = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
    number,
    id
  ]);
}

export async function setSupplierInvoiceFile(db, id, { key, name, size }) {
  await db.execute(
    `UPDATE invoices
     SET supplier_invoice_file_key = ?, supplier_invoice_file_name = ?, supplier_invoice_file_size = ?,
         supplier_invoice_uploaded_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [key, name, size, id]
  );
}

export async function clearSupplierInvoiceFile(db, id) {
  await db.execute(
    `UPDATE invoices
     SET supplier_invoice_file_key = NULL, supplier_invoice_file_name = NULL, supplier_invoice_file_size = NULL,
         supplier_invoice_uploaded_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [id]
  );
}

export async function findSupplierInvoiceFile(db, id) {
  const [rows] = await db.execute(
    `SELECT supplier_invoice_file_key AS \`key\`, supplier_invoice_file_name AS name
     FROM invoices WHERE id = ? AND type = ?`,
    [id, TYPE]
  );
  return rows[0] ?? null;
}

export async function insertRefund(connection, { invoiceId, amount, refundMethod, refundDate, notes = null }, createdBy = null) {
  const [result] = await connection.execute(
    `INSERT INTO purchase_refunds (refund_number, invoice_id, amount, refund_method, refund_date, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`TEMP-${randomUUID()}`, invoiceId, amount, refundMethod, refundDate, notes, createdBy]
  );
  const id = result.insertId;
  await connection.execute('UPDATE purchase_refunds SET refund_number = ? WHERE id = ?', [
    `REF-${String(id).padStart(6, '0')}`,
    id
  ]);
  return id;
}

export async function findRefundById(db, id) {
  const [rows] = await db.execute(
    `SELECT id, refund_number, invoice_id, amount, refund_method, refund_date, notes, created_by, created_at
     FROM purchase_refunds WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}
