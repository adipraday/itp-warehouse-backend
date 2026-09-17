import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const HEADER_COLUMNS = `id, invoice_number, warehouse_id, contact_id, type, status,
       reversal_of_invoice_id, reversal_reason, inventory_transaction_id,
       invoice_date, due_date, subtotal, discount_amount, tax, total_amount, payment_status, notes,
       created_by, completed_by, completed_at, cancelled_at, created_at, updated_at`;

// buIds scopes results to warehouses owned by any of the caller's business units.
function buildFilter({ type, status, paymentStatus, warehouseId, buIds, assignedWarehouseIds }) {
  const conditions = [];
  const params = [];
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (paymentStatus) {
    conditions.push('payment_status = ?');
    params.push(paymentStatus);
  }
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
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function findAll(db, { type, status, paymentStatus, warehouseId, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ type, status, paymentStatus, warehouseId, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM invoices ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { type, status, paymentStatus, warehouseId, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ type, status, paymentStatus, warehouseId, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM invoices ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${HEADER_COLUMNS} FROM invoices WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

// Locks an invoice of either type; used by payment posting, which applies uniformly to both.
export async function findByIdForUpdate(connection, id) {
  const [rows] = await connection.execute(`SELECT ${HEADER_COLUMNS} FROM invoices WHERE id = ? FOR UPDATE`, [id]);
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

export async function updatePaymentStatus(connection, id, paymentStatus) {
  await connection.execute('UPDATE invoices SET payment_status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
    paymentStatus,
    id
  ]);
}
