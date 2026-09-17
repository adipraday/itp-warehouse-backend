import { randomUUID } from 'node:crypto';
import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const TYPE = 'SALES';

const HEADER_COLUMNS = `id, invoice_number, warehouse_id, contact_id, type, status, held_at, hold_label,
       reversal_of_invoice_id, reversal_reason, inventory_transaction_id,
       invoice_date, due_date, subtotal, discount_amount, tax, total_amount, payment_status, notes,
       created_by, completed_by, completed_at, cancelled_at, created_at, updated_at`;

// buIds scopes results to warehouses owned by any of the caller's business units.
function buildFilter({ warehouseId, status, held, buIds, assignedWarehouseIds }) {
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
  if (held === true) {
    conditions.push('held_at IS NOT NULL');
  } else if (held === false) {
    conditions.push('held_at IS NULL');
  }
  return { clause: conditions.join(' AND '), params };
}

export async function findAll(db, { warehouseId, status, held, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ warehouseId, status, held, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM invoices WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { warehouseId, status, held, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ warehouseId, status, held, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM invoices WHERE ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${HEADER_COLUMNS} FROM invoices WHERE id = ? AND type = ?`, [id, TYPE]);
  return rows[0] ?? null;
}

export async function findByIdForUpdate(connection, id) {
  const [rows] = await connection.execute(`SELECT ${HEADER_COLUMNS} FROM invoices WHERE id = ? AND type = ? FOR UPDATE`, [
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
    `SELECT d.id, d.item_id, i.sku, i.name, d.quantity, d.unit_price, d.amount, d.unit_cost, d.cost_amount
     FROM invoice_details d
     JOIN items i ON i.id = d.item_id
     WHERE d.invoice_id = ?
     ORDER BY d.item_id ASC`,
    [invoiceId]
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
  invoice_date,
  due_date = null,
  notes = null,
  reversal_of_invoice_id = null,
  reversal_reason = null
}, createdBy = null) {
  const [result] = await connection.execute(
    `INSERT INTO invoices
       (invoice_number, warehouse_id, contact_id, type, status, invoice_date, due_date, notes,
        reversal_of_invoice_id, reversal_reason, created_by)
     VALUES (?, ?, ?, 'SALES', 'DRAFT', ?, ?, ?, ?, ?, ?)`,
    [`TEMP-${randomUUID()}`, warehouse_id, contact_id, invoice_date, due_date, notes, reversal_of_invoice_id, reversal_reason, createdBy]
  );
  const id = result.insertId;
  await connection.execute('UPDATE invoices SET invoice_number = ? WHERE id = ?', [`SAL-${String(id).padStart(6, '0')}`, id]);
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

export async function updateHeader(connection, id, { warehouse_id, contact_id = null, invoice_date, due_date = null, notes = null }) {
  await connection.execute(
    `UPDATE invoices SET warehouse_id = ?, contact_id = ?, invoice_date = ?, due_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [warehouse_id, contact_id, invoice_date, due_date, notes, id]
  );
}

// subtotal is always derived from invoice_details; tax_rate/discountAmount are
// transient client inputs applied here, never client-supplied absolute
// tax/total values. discountAmount is a flat transaction-level amount
// (validated <= subtotal by the caller), applied BEFORE tax — tax is charged
// on the post-discount amount, matching how a real receipt reads (Subtotal,
// Diskon, Pajak dari sisa, Total).
export async function computeAndStoreTotals(connection, invoiceId, taxRate, discountAmount = 0) {
  const [rows] = await connection.execute(
    'SELECT COALESCE(SUM(amount), 0) AS subtotal FROM invoice_details WHERE invoice_id = ?',
    [invoiceId]
  );
  const subtotal = Number(rows[0].subtotal ?? 0);
  const taxableBase = Math.max(subtotal - discountAmount, 0);
  const tax = Number((taxableBase * taxRate).toFixed(2));
  const totalAmount = Number((taxableBase + tax).toFixed(2));

  await connection.execute(
    'UPDATE invoices SET subtotal = ?, discount_amount = ?, tax = ?, total_amount = ? WHERE id = ?',
    [subtotal.toFixed(2), discountAmount.toFixed(2), tax.toFixed(2), totalAmount.toFixed(2), invoiceId]
  );
}

export async function setDetailCost(connection, detailId, { unit_cost, cost_amount }) {
  await connection.execute('UPDATE invoice_details SET unit_cost = ?, cost_amount = ? WHERE id = ?', [
    unit_cost,
    cost_amount,
    detailId
  ]);
}

export async function remove(db, id) {
  await db.execute('DELETE FROM invoices WHERE id = ? AND type = ?', [id, TYPE]);
}

export async function markCompleted(connection, id, inventoryTransactionId, completedBy = null) {
  await connection.execute(
    `UPDATE invoices
     SET status = 'COMPLETED', inventory_transaction_id = ?, completed_by = ?, completed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [inventoryTransactionId, completedBy, id]
  );
}

export async function markCancelled(db, id) {
  await db.execute(
    `UPDATE invoices SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'DRAFT'`,
    [id]
  );
}

// Re-holdable — calling this again on an already-held sale just refreshes
// held_at and swaps the label, no error. See sales.service.js for the
// DRAFT-only guard.
export async function markHeld(db, id, holdLabel = null) {
  await db.execute(
    `UPDATE invoices SET held_at = CURRENT_TIMESTAMP(3), hold_label = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [holdLabel, id]
  );
}

// hold_label is deliberately left alone — harmless history of what it was
// last labeled, in case it gets held again later.
export async function markResumed(db, id) {
  await db.execute(`UPDATE invoices SET held_at = NULL, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [id]);
}
