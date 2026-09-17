import { randomUUID } from 'node:crypto';
import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

// A payment has no warehouse_id of its own — it references an invoice, which
// references a warehouse. buIds scoping needs a JOIN, unlike every other module.
function buildFilter({ invoiceId, from, to, buIds, assignedWarehouseIds }) {
  const conditions = [];
  const params = [];
  if (invoiceId) {
    conditions.push('p.invoice_id = ?');
    params.push(invoiceId);
  }
  if (from) {
    conditions.push('p.payment_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('p.payment_date <= ?');
    params.push(to);
  }
  const bu = buIdsCondition('i.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('i.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

const COLUMNS =
  'p.id, p.payment_number, p.invoice_id, p.cash_session_id, p.amount, p.amount_tendered, p.change_amount, p.payment_method, p.payment_date, p.notes, p.created_by, p.created_at';
const JOIN = 'JOIN invoices i ON i.id = p.invoice_id';

export async function findAll(db, { invoiceId, from, to, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ invoiceId, from, to, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM payments p ${JOIN} ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { invoiceId, from, to, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ invoiceId, from, to, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM payments p ${JOIN} ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM payments p WHERE p.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByInvoiceId(db, invoiceId, { limit, offset }) {
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM payments p WHERE p.invoice_id = ? ORDER BY p.payment_date ASC, p.id ASC LIMIT ? OFFSET ?`,
    [invoiceId, limit, offset]
  );
  return rows;
}

export async function countByInvoiceId(db, invoiceId) {
  const [rows] = await db.execute('SELECT COUNT(*) AS total FROM payments WHERE invoice_id = ?', [invoiceId]);
  return Number(rows[0].total);
}

export async function sumByInvoiceId(connection, invoiceId) {
  const [rows] = await connection.execute('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = ?', [
    invoiceId
  ]);
  return Number(rows[0].total ?? 0);
}

export async function create(
  connection,
  {
    invoice_id,
    cash_session_id = null,
    amount,
    amount_tendered,
    change_amount = 0,
    payment_method,
    payment_date,
    notes = null
  },
  createdBy = null
) {
  const [result] = await connection.execute(
    `INSERT INTO payments
       (payment_number, invoice_id, cash_session_id, amount, amount_tendered, change_amount, payment_method, payment_date, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `TEMP-${randomUUID()}`,
      invoice_id,
      cash_session_id,
      amount,
      amount_tendered,
      change_amount,
      payment_method,
      payment_date,
      notes,
      createdBy
    ]
  );
  const id = result.insertId;
  await connection.execute('UPDATE payments SET payment_number = ? WHERE id = ?', [`PAY-${String(id).padStart(6, '0')}`, id]);
  return id;
}
