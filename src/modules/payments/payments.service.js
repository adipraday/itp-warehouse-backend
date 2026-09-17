import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { withTransaction } from '../../shared/database/transaction.js';
import * as repository from './payments.repository.js';
import * as invoicesRepository from '../invoices/invoices.repository.js';
import * as cashSessionsRepository from '../cash-sessions/cash-sessions.repository.js';

function computePaymentStatus(totalPaid, totalAmount) {
  if (totalPaid <= 0) return 'UNPAID';
  if (totalPaid >= totalAmount) return 'PAID';
  return 'PARTIAL';
}

export async function listPayments(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    invoiceId: query.invoice_id ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getPayment(db, id) {
  const payment = await repository.findById(db, id);
  if (!payment) throw new NotFoundError(`Payment ${id} not found`);
  return { data: payment };
}

export async function listInvoicePayments(db, invoiceId, query) {
  const invoice = await invoicesRepository.findById(db, invoiceId);
  if (!invoice) throw new NotFoundError(`Invoice ${invoiceId} not found`);

  const { page, per_page, offset } = parsePagination(query);
  const [data, total] = await Promise.all([
    repository.findByInvoiceId(db, invoiceId, { limit: per_page, offset }),
    repository.countByInvoiceId(db, invoiceId)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function createPayment(pool, payload, userId = null) {
  // amount_tendered = physical cash actually handed over (only meaningful for
  // CASH — for anything else it's just whatever was charged, no change
  // involved). Defaults to `amount` when omitted, which naturally yields
  // change_amount 0. `amount` keeps its existing meaning unchanged: exactly
  // what's applied to the invoice's balance — cash-sessions.js's cash
  // reconciliation still sums this same field, since tendered - change always
  // equals amount (what actually stays in the drawer).
  const amountTendered = payload.amount_tendered ?? payload.amount;
  if (amountTendered < payload.amount) {
    throw new BadRequestError(
      'AMOUNT_TENDERED_TOO_LOW',
      `amount_tendered (${amountTendered}) cannot be less than amount (${payload.amount})`
    );
  }
  const changeAmount = Number((amountTendered - payload.amount).toFixed(2));

  const id = await withTransaction(pool, async (connection) => {
    const invoice = await invoicesRepository.findByIdForUpdate(connection, payload.invoice_id);
    if (!invoice) throw new NotFoundError(`Invoice ${payload.invoice_id} not found`);
    if (invoice.status !== 'COMPLETED') {
      throw new ConflictError('INVALID_STATUS', 'Payments can only be posted against a COMPLETED invoice');
    }

    const totalPaid = await repository.sumByInvoiceId(connection, payload.invoice_id);
    const remaining = Number(invoice.total_amount) - totalPaid;

    if (payload.amount > remaining) {
      throw new ConflictError('AMOUNT_EXCEEDS_BALANCE', `Payment amount exceeds the remaining balance of ${remaining.toFixed(2)}`);
    }

    // Never client-supplied — reflects whichever shift the cashier actually
    // has open right now for THIS invoice's warehouse, same "resolve
    // server-side, never trust the client" convention as bu_id elsewhere.
    // null (no open session) is a normal case — e.g. finance settling a B2B
    // invoice has no register/shift involved at all.
    const openSession = userId
      ? await cashSessionsRepository.findOpenByUserAndWarehouse(connection, userId, invoice.warehouse_id)
      : null;

    const paymentId = await repository.create(
      connection,
      { ...payload, cash_session_id: openSession?.id ?? null, amount_tendered: amountTendered, change_amount: changeAmount },
      userId
    );

    const newTotalPaid = totalPaid + payload.amount;
    const paymentStatus = computePaymentStatus(newTotalPaid, Number(invoice.total_amount));
    await invoicesRepository.updatePaymentStatus(connection, payload.invoice_id, paymentStatus);

    return paymentId;
  });

  const created = await repository.findById(pool, id);
  return { data: created };
}
