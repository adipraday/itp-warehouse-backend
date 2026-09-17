import { NotFoundError, ConflictError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import * as repository from './cash-sessions.repository.js';

// The system's belief of what should physically be in the drawer right now:
// starting float + cash collected so far - cash already paid out as
// expenses. Shared by withSummary() (live preview / final report),
// addExpense() (can't pay out more than this), and closeCashSession()
// (this IS expected_cash_amount at close time).
async function computeExpectedCash(db, session) {
  const [cashTotal, expensesTotal] = await Promise.all([
    repository.sumCashBySession(db, session.id),
    repository.sumExpensesBySession(db, session.id)
  ]);
  return { cashTotal, expensesTotal, expectedCash: Number(session.opening_amount) + cashTotal - expensesTotal };
}

async function withSummary(db, session) {
  const [byMethod, { expensesTotal, expectedCash }, expenses] = await Promise.all([
    repository.summaryByMethod(db, session.id),
    computeExpectedCash(db, session),
    repository.findExpensesBySession(db, session.id)
  ]);
  const totalAmount = byMethod.reduce((sum, row) => sum + Number(row.amount), 0);
  const totalCount = byMethod.reduce((sum, row) => sum + row.count, 0);

  return {
    ...session,
    summary: {
      by_method: byMethod,
      total_amount: totalAmount.toFixed(2),
      total_count: totalCount,
      expenses: expenses.map((e) => ({
        id: e.id,
        amount: e.amount,
        description: e.description,
        created_at: e.created_at
      })),
      total_expenses: expensesTotal.toFixed(2),
      // Always computed live from what's actually tagged to this session —
      // for a CLOSED session this necessarily equals expected_cash_amount
      // (nothing can attach to a session once it's closed), so this doubles
      // as a running preview while still OPEN ("kalau ditutup sekarang...").
      live_expected_cash: expectedCash.toFixed(2)
    }
  };
}

export async function listCashSessions(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    warehouseId: query.warehouse_id ?? null,
    userId: query.user_id ?? null,
    status: query.status ?? null,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getCashSession(db, id) {
  const session = await repository.findById(db, id);
  if (!session) throw new NotFoundError(`Cash session ${id} not found`);
  return { data: await withSummary(db, session) };
}

// The POS bootstrap call: "is this cashier mid-shift already?" — null data
// (not a 404) when there's no open session, since "none open" is a normal,
// expected answer, not an error.
export async function getCurrentCashSession(db, userId) {
  const session = await repository.findOpenByUser(db, userId);
  return { data: session ? await withSummary(db, session) : null };
}

export async function openCashSession(db, payload, userId) {
  const existing = await repository.findOpenByUser(db, userId);
  if (existing) {
    throw new ConflictError(
      'CASH_SESSION_ALREADY_OPEN',
      `You already have an open cash session (id=${existing.id}) at warehouse ${existing.warehouse_id} — close it before opening a new one`
    );
  }

  const session = await repository.create(db, payload, userId);
  return { data: session };
}

// Cash Out / Paid Out — an operational expense paid straight from the
// drawer during the shift (e.g. "beli galon air"), never a sale/payment.
// Rejected if it would pay out more than the drawer is expected to hold —
// same "can't apply more than what exists" guard as payments.service.js's
// AMOUNT_EXCEEDS_BALANCE check.
export async function addExpense(db, id, { amount, description }, userId = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Cash session ${id} not found`);
  if (existing.status !== 'OPEN') {
    throw new ConflictError('INVALID_STATUS', 'Expenses can only be recorded against an OPEN cash session');
  }

  const { expectedCash } = await computeExpectedCash(db, existing);
  if (amount > expectedCash) {
    throw new ConflictError(
      'INSUFFICIENT_CASH_IN_DRAWER',
      `Expense amount (${amount}) exceeds the cash currently expected in the drawer (${expectedCash.toFixed(2)})`
    );
  }

  await repository.createExpense(db, { cash_session_id: id, amount, description }, userId);
  const updated = await repository.findById(db, id);
  return { data: await withSummary(db, updated) };
}

export async function closeCashSession(db, id, { closing_amount, notes }) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Cash session ${id} not found`);
  if (existing.status !== 'OPEN') {
    throw new ConflictError('INVALID_STATUS', 'Only an OPEN cash session can be closed');
  }

  const { expectedCash } = await computeExpectedCash(db, existing);
  const cashDifference = Number(closing_amount) - expectedCash;

  const session = await repository.close(db, id, {
    closing_amount,
    expected_cash_amount: expectedCash.toFixed(2),
    cash_difference: cashDifference.toFixed(2),
    notes
  });
  return { data: await withSummary(db, session) };
}
