import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const COLUMNS = `id, warehouse_id, user_id, status, opening_amount, closing_amount,
       expected_cash_amount, cash_difference, opened_at, closed_at, notes, created_at, updated_at`;

export async function create(db, { warehouse_id, opening_amount = 0, notes = null }, userId) {
  const [result] = await db.execute(
    'INSERT INTO cash_sessions (warehouse_id, user_id, opening_amount, notes) VALUES (?, ?, ?, ?)',
    [warehouse_id, userId, opening_amount, notes]
  );
  return findById(db, result.insertId);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM cash_sessions WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

// The constraint this whole feature relies on: a cashier can only run one
// register at a time. Checked before opening a new session, and used by
// payments.service.js to auto-tag a payment with the cashier's active shift.
export async function findOpenByUser(db, userId) {
  const [rows] = await db.execute(`SELECT ${COLUMNS} FROM cash_sessions WHERE user_id = ? AND status = 'OPEN'`, [
    userId
  ]);
  return rows[0] ?? null;
}

export async function findOpenByUserAndWarehouse(db, userId, warehouseId) {
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM cash_sessions WHERE user_id = ? AND warehouse_id = ? AND status = 'OPEN'`,
    [userId, warehouseId]
  );
  return rows[0] ?? null;
}

export async function close(db, id, { closing_amount, expected_cash_amount, cash_difference, notes }) {
  await db.execute(
    `UPDATE cash_sessions
     SET status = 'CLOSED', closing_amount = ?, expected_cash_amount = ?, cash_difference = ?,
         notes = COALESCE(?, notes), closed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [closing_amount, expected_cash_amount, cash_difference, notes ?? null, id]
  );
  return findById(db, id);
}

function buildFilter({ warehouseId, userId, status, buIds, assignedWarehouseIds }) {
  const conditions = [];
  const params = [];
  if (warehouseId) {
    conditions.push('warehouse_id = ?');
    params.push(warehouseId);
  }
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
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

export async function findAll(db, { limit, offset, ...filter }) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db.execute(
    `SELECT ${COLUMNS} FROM cash_sessions ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, filter) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM cash_sessions ${clause}`, params);
  return Number(rows[0].total);
}

// Cash-only total (case-insensitive "CASH") tied to this session — the number
// that actually has to be physically in the drawer at close time. Every other
// payment_method (QRIS, debit, etc.) never touches the drawer, so it's
// deliberately excluded here even though it still counts in summaryByMethod().
export async function sumCashBySession(db, sessionId) {
  const [rows] = await db.execute(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE cash_session_id = ? AND UPPER(payment_method) = 'CASH'`,
    [sessionId]
  );
  return Number(rows[0].total ?? 0);
}

// Full breakdown for the session report (X-report while OPEN, Z-report once
// CLOSED — same query either way, see cash-sessions.service.js).
export async function summaryByMethod(db, sessionId) {
  const [rows] = await db.execute(
    `SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
     FROM payments WHERE cash_session_id = ? GROUP BY payment_method ORDER BY payment_method ASC`,
    [sessionId]
  );
  return rows.map((row) => ({ method: row.payment_method, count: Number(row.count), amount: Number(row.total).toFixed(2) }));
}

// Cash Out / Paid Out — operational expenses paid straight from the drawer
// during an OPEN session (e.g. "beli galon air"), never a sale/payment. See
// the 202609130005 migration.
export async function createExpense(db, { cash_session_id, amount, description }, createdBy = null) {
  const [result] = await db.execute(
    'INSERT INTO cash_session_expenses (cash_session_id, amount, description, created_by) VALUES (?, ?, ?, ?)',
    [cash_session_id, amount, description, createdBy]
  );
  const [rows] = await db.execute(
    'SELECT id, cash_session_id, amount, description, created_by, created_at FROM cash_session_expenses WHERE id = ?',
    [result.insertId]
  );
  return rows[0];
}

export async function sumExpensesBySession(db, sessionId) {
  const [rows] = await db.execute(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM cash_session_expenses WHERE cash_session_id = ?',
    [sessionId]
  );
  return Number(rows[0].total ?? 0);
}

export async function findExpensesBySession(db, sessionId) {
  const [rows] = await db.execute(
    `SELECT id, cash_session_id, amount, description, created_by, created_at
     FROM cash_session_expenses WHERE cash_session_id = ? ORDER BY created_at ASC, id ASC`,
    [sessionId]
  );
  return rows;
}
