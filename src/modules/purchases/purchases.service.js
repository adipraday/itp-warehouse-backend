import { randomUUID } from 'node:crypto';
import { AppError, NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { withIdempotency } from '../../shared/idempotency/idempotency.guard.js';
import * as repository from './purchases.repository.js';
import * as invoicesRepository from '../invoices/invoices.repository.js';
import * as inboundsRepository from '../inventory/inbounds/inbounds.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../inventory/costing/cost-layers.repository.js';
import * as warehousesRepository from '../warehouses/warehouses.repository.js';
import { assertItemsInScope, assertContactInScope } from '../../shared/auth/master-data-scope.js';
import { notifyStakeholders, notifyUsers } from '../../shared/notifications/push.js';

const MAX_SUPPLIER_INVOICE_BYTES = 10 * 1024 * 1024;

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  return error;
}

function paymentStatusFor(totalPaid, totalAmount) {
  if (totalPaid <= 0) return 'UNPAID';
  if (totalPaid >= totalAmount) return 'PAID';
  return 'PARTIAL';
}

async function assertReversalTarget(db, reversalOfInvoiceId, reversalReason) {
  if (!reversalOfInvoiceId) return;
  if (!reversalReason) {
    throw new BadRequestError('REVERSAL_REASON_REQUIRED', 'reversal_reason is required when reversal_of_invoice_id is set');
  }
  const original = await repository.findAnyById(db, reversalOfInvoiceId);
  if (!original || original.status !== 'COMPLETED') {
    throw new BadRequestError('INVALID_REVERSAL_TARGET', 'reversal_of_invoice_id must reference a COMPLETED invoice');
  }
}

// Accepting goods into stock is the independent check on the purchase, so an admin-warehouse may do
// it only at a warehouse they are assigned to and never for a purchase they created themselves.
// admin-bu / super-admin keep their BU-wide authority (already scoped by buScope() on the route).
export function assertMayReceivePurchase(purchase, context) {
  if (context?.role !== 'admin-warehouse') return;

  const assigned = (context.assignedWarehouseIds ?? []).map(Number);
  if (!assigned.includes(Number(purchase.warehouse_id))) {
    throw forbidden('You may only approve a purchase for a warehouse you are assigned to');
  }
  if (purchase.created_by != null && Number(purchase.created_by) === Number(context.userId)) {
    throw forbidden('You cannot approve a purchase you created yourself');
  }
}

// A purchase that is paid but not yet (fully) received is locked: editing it would change a total
// that money has already been paid against.
function assertEditable(purchase, paid) {
  if (purchase.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT purchase can be changed');
  }
  if (purchase.receipt_status) {
    throw new ConflictError('PURCHASE_LOCKED', 'This purchase was already submitted for warehouse approval and can no longer be edited');
  }
  if (paid > 0) {
    throw new ConflictError(
      'PURCHASE_LOCKED',
      'This purchase already has a payment and can no longer be edited. Cancel it (the payment is refunded) and create a new one.'
    );
  }
}

export async function listPurchases(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    warehouseId: query.warehouse_id ?? null,
    status: query.status ?? null,
    receiptStatus: query.receipt_status ?? null,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getPurchase(db, id) {
  const purchase = await repository.findByIdWithDetails(db, id);
  if (!purchase) throw new NotFoundError(`Purchase ${id} not found`);
  return { data: purchase };
}

export async function createPurchase(pool, payload, userId = null, buIds = null) {
  await assertReversalTarget(pool, payload.reversal_of_invoice_id, payload.reversal_reason);
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);
  const taxRate = payload.tax_rate ?? 0;

  const id = await withTransaction(pool, async (connection) => {
    const invoiceId = await repository.insertHeader(connection, { ...payload, tax_rate: taxRate }, userId);
    await repository.insertDetails(connection, invoiceId, payload.details);
    await repository.computeAndStoreTotals(connection, invoiceId, taxRate);
    return invoiceId;
  });

  const created = await repository.findByIdWithDetails(pool, id);
  return { data: created };
}

export async function updatePurchase(pool, id, payload, buIds = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Purchase ${id} not found`);
  assertEditable(existing, Number(existing.paid_amount));
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);
  const taxRate = payload.tax_rate ?? 0;

  await withTransaction(pool, async (connection) => {
    await repository.updateHeader(connection, id, { ...payload, tax_rate: taxRate });
    await repository.replaceDetails(connection, id, payload.details);
    await repository.computeAndStoreTotals(connection, id, taxRate);
  });

  const updated = await repository.findByIdWithDetails(pool, id);
  return { data: updated };
}

export async function deletePurchase(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Purchase ${id} not found`);
  assertEditable(existing, Number(existing.paid_amount));

  await repository.remove(pool, id);
  return { data: { id: Number(id) } };
}

// Step 2 of the flow: once the purchase is paid it is handed to the destination warehouse. From here
// on only the warehouse's approval can put the goods into stock.
export async function submitPurchase(pool, id, userId = null) {
  const purchase = await withTransaction(pool, async (connection) => {
    const existing = await repository.findByIdForUpdate(connection, id);
    if (!existing) throw new NotFoundError(`Purchase ${id} not found`);
    if (existing.status !== 'DRAFT' || existing.receipt_status) {
      throw new ConflictError('INVALID_STATUS', 'Only a DRAFT purchase that has not been submitted yet can be submitted');
    }
    if (Number(existing.total_amount) > 0 && existing.payment_status !== 'PAID') {
      throw new ConflictError(
        'PAYMENT_REQUIRED',
        'The purchase must be fully paid before it is submitted for warehouse approval'
      );
    }
    await repository.markSubmitted(connection, id, userId);
    return existing;
  });

  const submitted = await repository.findByIdWithDetails(pool, id);

  // Best-effort: a notification failure must never undo the submit that already succeeded.
  try {
    const warehouse = await warehousesRepository.findById(pool, purchase.warehouse_id);
    await notifyStakeholders(pool, {
      buId: warehouse?.bu_id ?? null,
      warehouseId: purchase.warehouse_id,
      warehouseRoles: ['admin-warehouse'],
      title: 'Pembelian Menunggu Persetujuan',
      body: `Pembelian ${purchase.invoice_number} sudah dibayar dan menunggu persetujuan penerimaan barang.`,
      data: { type: 'purchase', id: Number(id) }
    });
  } catch (error) {
    console.warn('[push] purchase submit notification failed', { id, error: error.message });
  }

  return { data: submitted };
}

// Everything still to arrive (not received, not closed out) on one line.
function remainingOf(detail) {
  return Number(detail.quantity) - Number(detail.closed_quantity) - Number(detail.received_quantity);
}

// Turns the part that will never arrive into closed quantity, then re-prices the purchase from what
// was finally bought and re-derives its payment status. Anything paid beyond the new total becomes
// "refund due". Returns the new total.
async function closeOutRemainder(connection, purchase, details) {
  for (const detail of details) {
    const remaining = remainingOf(detail);
    if (remaining > 0) await repository.addClosedQuantity(connection, detail.id, remaining);
  }
  const total = await repository.computeAndStoreTotals(connection, purchase.id, Number(purchase.tax_rate));
  const paid = await repository.sumPaid(connection, purchase.id);
  await invoicesRepository.updatePaymentStatus(connection, purchase.id, paymentStatusFor(paid, total));
  return { total, paid };
}

async function notifyRefundDue(pool, purchase, refundDue, headline) {
  if (!(refundDue > 0)) return;
  try {
    const warehouse = await warehousesRepository.findById(pool, purchase.warehouse_id);
    const amount = `Rp ${refundDue.toLocaleString('id-ID')}`;
    await notifyStakeholders(pool, {
      buId: warehouse?.bu_id ?? null,
      extraBuRoles: ['finance'],
      includeOwner: true,
      title: 'Pengembalian Dana Supplier',
      body: `${headline} ${purchase.invoice_number}: ${amount} perlu dikembalikan oleh supplier.`,
      data: { type: 'purchase_refund_due', id: purchase.id }
    });
  } catch (error) {
    console.warn('[push] purchase refund-due notification failed', { id: purchase.id, error: error.message });
  }
}

// Tells whoever created the purchase that the warehouse has approved a receipt, so they do not have to
// keep opening the document to see whether the goods arrived. Skipped when the creator is the one who
// approved (nothing to tell). Best-effort: never fails a receipt that already committed.
async function notifyPurchaseCreator(pool, purchase, summary, approverId) {
  if (purchase.created_by == null || Number(purchase.created_by) === Number(approverId)) return;
  let body;
  if (summary.outstanding === 0) {
    body = `Barang pembelian ${purchase.invoice_number} sudah diterima di gudang dan masuk stok.`;
  } else if (summary.shortfallAction === 'REFUND') {
    body = `Pembelian ${purchase.invoice_number} diterima sebagian (${summary.received} unit). Sisa ${summary.outstanding} unit ditutup dan dananya diminta kembali dari supplier.`;
  } else {
    body = `Pembelian ${purchase.invoice_number} diterima sebagian (${summary.received} unit). Sisa ${summary.outstanding} unit menunggu pengganti dari supplier.`;
  }
  try {
    await notifyUsers(pool, {
      userIds: [Number(purchase.created_by)],
      title: 'Barang Pembelian Diterima',
      body,
      data: { type: 'purchase', id: purchase.id }
    });
  } catch (error) {
    console.warn('[push] purchase received notification failed', { id: purchase.id, error: error.message });
  }
}

// Step 3: the destination warehouse approves what was actually received. Only the received quantities
// go into stock (with their own FIFO cost layers). What is still missing is either awaited (the
// supplier replaces it — retur/penggantian) or closed out, in which case the supplier owes a refund.
//
// `lines` omitted = everything still outstanding arrived. Otherwise it lists { item_id, quantity };
// an item left out is treated as 0 received.
export async function receivePurchase(pool, id, options) {
  const { idempotencyKey, endpoint, body, ttlHours, userId = null, context = null, lines, shortfallAction, notes = null } = options;
  let closedOut = null;
  let headerForNotify = null;
  let receiptSummary = null;

  const result = await withTransaction(pool, (connection) =>
    withIdempotency(connection, { key: idempotencyKey, endpoint, body, ttlHours }, async () => {
      const purchase = await repository.findByIdForUpdate(connection, id);
      if (!purchase) throw new NotFoundError(`Purchase ${id} not found`);
      assertMayReceivePurchase(purchase, context);

      if (purchase.status !== 'DRAFT') {
        throw new ConflictError('INVALID_STATUS', 'Only a purchase awaiting warehouse approval can be received');
      }
      if (!purchase.receipt_status) {
        throw new ConflictError(
          'APPROVAL_REQUIRED',
          'The purchase must be paid and submitted for warehouse approval before goods can be received'
        );
      }

      const details = await repository.findDetailsForUpdate(connection, id);
      const received = new Map();
      if (lines == null) {
        for (const detail of details) received.set(detail.item_id, remainingOf(detail));
      } else {
        for (const line of lines) {
          const detail = details.find((d) => d.item_id === line.item_id);
          if (!detail) {
            throw new BadRequestError('ITEM_NOT_ON_PURCHASE', `Item ${line.item_id} is not on this purchase`);
          }
          if (received.has(line.item_id)) {
            throw new BadRequestError('DUPLICATE_ITEM', `Item ${line.item_id} appears more than once`);
          }
          if (line.quantity > remainingOf(detail)) {
            throw new ConflictError(
              'RECEIVED_QUANTITY_EXCEEDS_ORDERED',
              `Item ${line.item_id}: received quantity exceeds the outstanding quantity of ${remainingOf(detail)}`
            );
          }
          received.set(line.item_id, line.quantity);
        }
      }

      const receivedDetails = details.filter((d) => (received.get(d.item_id) ?? 0) > 0);
      if (receivedDetails.length === 0) {
        throw new BadRequestError(
          'NOTHING_RECEIVED',
          'At least one item must have a received quantity. To reject the whole delivery, cancel the purchase instead.'
        );
      }

      const outstandingAfter = details.reduce((sum, d) => sum + remainingOf(d) - (received.get(d.item_id) ?? 0), 0);
      const hasShortfall = outstandingAfter > 0;
      if (hasShortfall && !shortfallAction) {
        throw new BadRequestError(
          'SHORTFALL_ACTION_REQUIRED',
          'Some quantities were not received. Choose WAIT (await a replacement) or REFUND (close the shortfall and refund it).'
        );
      }

      const transactionId = await inboundsRepository.insertHeader(connection, {
        warehouse_id: purchase.warehouse_id,
        contact_id: purchase.contact_id,
        transaction_date: purchase.invoice_date,
        notes: `Purchase ${purchase.invoice_number}`
      }, userId);
      await inboundsRepository.insertDetails(
        connection,
        transactionId,
        receivedDetails.map((d) => ({ item_id: d.item_id, quantity: received.get(d.item_id), unit_price: d.unit_price }))
      );

      for (const detail of receivedDetails) {
        const quantity = received.get(detail.item_id);
        await stocksRepository.ensureRow(connection, purchase.warehouse_id, detail.item_id);
        await stocksRepository.lockRow(connection, purchase.warehouse_id, detail.item_id);

        const totalCost = (quantity * Number(detail.unit_price)).toFixed(2);

        const mutationId = await stockMutationsRepository.create(connection, {
          warehouse_id: purchase.warehouse_id,
          item_id: detail.item_id,
          type: 'IN',
          direction: 'IN',
          quantity,
          total_cost: totalCost,
          source_type: 'INVENTORY_TRANSACTION',
          source_id: transactionId,
          inventory_transaction_id: transactionId
        });

        await costLayersRepository.create(connection, {
          warehouse_id: purchase.warehouse_id,
          item_id: detail.item_id,
          source_stock_mutation_id: mutationId,
          quantity_received: quantity,
          quantity_remaining: quantity,
          unit_cost: detail.unit_price
        });

        await stocksRepository.increment(connection, purchase.warehouse_id, detail.item_id, quantity);
        await repository.addReceivedQuantity(connection, detail.id, quantity);
        detail.received_quantity = Number(detail.received_quantity) + quantity;
      }

      await inboundsRepository.markCompleted(connection, transactionId, userId);
      await repository.insertReceipt(connection, { invoiceId: purchase.id, inventoryTransactionId: transactionId, receivedBy: userId, notes });

      if (hasShortfall && shortfallAction === 'WAIT') {
        await repository.markPartiallyReceived(connection, id, transactionId);
      } else {
        if (hasShortfall) {
          closedOut = await closeOutRemainder(connection, purchase, details);
          if (notes) await repository.setCancelReason(connection, id, notes);
        }
        await repository.markCompleted(connection, id, transactionId, userId);
      }

      headerForNotify = purchase;
      receiptSummary = {
        received: receivedDetails.reduce((sum, d) => sum + received.get(d.item_id), 0),
        outstanding: outstandingAfter,
        shortfallAction: hasShortfall ? shortfallAction : null
      };
      const updated = await repository.findByIdWithDetails(connection, id);
      return { statusCode: 200, body: { data: updated } };
    })
  );

  if (!result.replayed && receiptSummary) {
    await notifyPurchaseCreator(pool, headerForNotify, receiptSummary, userId);
  }
  if (!result.replayed && closedOut) {
    await notifyRefundDue(pool, headerForNotify, Math.max(0, closedOut.paid - closedOut.total), 'Kekurangan barang pada');
  }
  return result;
}

// Cancels what has not been received. Nothing received yet → CANCELLED. Part already received →
// the remainder is closed out and the purchase ends COMPLETED. Either way, anything paid beyond the
// new total is refund due. A plain unpaid, unsubmitted draft is cancelled as before.
export async function cancelPurchase(pool, id, { reason = null } = {}, userId = null) {
  let refundDue = 0;
  let purchaseRow = null;

  await withTransaction(pool, async (connection) => {
    const existing = await repository.findByIdForUpdate(connection, id);
    if (!existing) throw new NotFoundError(`Purchase ${id} not found`);
    if (existing.status !== 'DRAFT') {
      throw new ConflictError('INVALID_STATUS', 'Only a DRAFT purchase can be cancelled');
    }
    purchaseRow = existing;

    const paid = await repository.sumPaid(connection, id);
    if (!existing.receipt_status && paid === 0) {
      await repository.markCancelled(connection, id, reason);
      return;
    }

    if (!reason || !String(reason).trim()) {
      throw new BadRequestError('CANCEL_REASON_REQUIRED', 'A reason is required to cancel a paid or submitted purchase');
    }

    const details = await repository.findDetailsForUpdate(connection, id);
    const anyReceived = details.some((d) => Number(d.received_quantity) > 0);
    const { total } = await closeOutRemainder(connection, existing, details);
    refundDue = Math.max(0, paid - total);

    if (anyReceived) {
      await repository.setCancelReason(connection, id, reason);
      await repository.markCompleted(connection, id, null, userId);
    } else {
      await repository.markCancelled(connection, id, reason);
    }
  });

  const cancelled = await repository.findByIdWithDetails(pool, id);
  await notifyRefundDue(pool, purchaseRow, refundDue, 'Pembatalan pembelian');
  return { data: cancelled };
}

// Money coming back from the supplier. Allowed only for what is actually refundable: paid beyond the
// final total, minus refunds already recorded.
export async function recordRefund(pool, id, payload, userId = null) {
  const refundId = await withTransaction(pool, async (connection) => {
    const purchase = await repository.findByIdForUpdate(connection, id);
    if (!purchase) throw new NotFoundError(`Purchase ${id} not found`);
    if (purchase.status !== 'COMPLETED' && purchase.status !== 'CANCELLED') {
      throw new ConflictError('INVALID_STATUS', 'A refund can only be recorded once the purchase is completed or cancelled');
    }

    const paid = await repository.sumPaid(connection, id);
    const refunded = await repository.sumRefunded(connection, id);
    const due = Math.max(0, paid - Number(purchase.total_amount) - refunded);
    if (payload.amount > due) {
      throw new ConflictError('AMOUNT_EXCEEDS_REFUND_DUE', `Refund amount exceeds the refund due of ${due.toFixed(2)}`);
    }

    return repository.insertRefund(
      connection,
      {
        invoiceId: id,
        amount: payload.amount,
        refundMethod: payload.refund_method,
        refundDate: payload.refund_date,
        notes: payload.notes ?? null
      },
      userId
    );
  });

  const refund = await repository.findRefundById(pool, refundId);
  const purchase = await repository.findByIdWithDetails(pool, id);
  return { data: refund, purchase };
}

// ---- Supplier's own invoice: number + PDF ---------------------------------------------------------

function requireStorage(storage) {
  if (!storage) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured on this server');
  }
}

async function requireLivePurchase(db, id) {
  const purchase = await repository.findById(db, id);
  if (!purchase) throw new NotFoundError(`Purchase ${id} not found`);
  if (purchase.status === 'CANCELLED') {
    throw new ConflictError('INVALID_STATUS', 'A cancelled purchase can no longer be changed');
  }
  return purchase;
}

export async function updateSupplierInvoiceNumber(pool, id, number) {
  await requireLivePurchase(pool, id);
  const value = number == null || String(number).trim() === '' ? null : String(number).trim();
  await repository.setSupplierInvoiceNumber(pool, id, value);
  return { data: await repository.findByIdWithDetails(pool, id) };
}

export async function uploadSupplierInvoiceFile(pool, storage, id, file) {
  requireStorage(storage);
  await requireLivePurchase(pool, id);

  if (!file?.buffer || file.buffer.length === 0) {
    throw new BadRequestError('FILE_REQUIRED', 'A PDF file is required');
  }
  if (file.truncated || file.buffer.length > MAX_SUPPLIER_INVOICE_BYTES) {
    throw new BadRequestError('FILE_TOO_LARGE', 'The PDF must be 10 MB or smaller');
  }
  // Both checks: the declared type alone is trivially spoofed, the magic bytes alone allow a wrong label.
  if (file.mimetype !== 'application/pdf' || file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new BadRequestError('INVALID_FILE_TYPE', 'Only PDF files are accepted');
  }

  const previous = await repository.findSupplierInvoiceFile(pool, id);
  const key = `purchase-invoices/${id}/${randomUUID()}.pdf`;
  const name = String(file.filename ?? 'invoice.pdf').split(/[\\/]/).pop().slice(0, 255) || 'invoice.pdf';

  await storage.putObject(key, file.buffer, 'application/pdf');
  await repository.setSupplierInvoiceFile(pool, id, { key, name, size: file.buffer.length });

  if (previous?.key) {
    try {
      await storage.deleteObject(previous.key);
    } catch (error) {
      console.warn('[storage] could not delete the replaced supplier invoice', { id, error: error.message });
    }
  }
  return { data: await repository.findByIdWithDetails(pool, id) };
}

export async function getSupplierInvoiceFile(pool, storage, id) {
  requireStorage(storage);
  const purchase = await repository.findById(pool, id);
  if (!purchase) throw new NotFoundError(`Purchase ${id} not found`);
  const file = await repository.findSupplierInvoiceFile(pool, id);
  if (!file?.key) throw new NotFoundError('This purchase has no supplier invoice file');

  const object = await storage.getObject(file.key);
  if (!object) throw new NotFoundError('The supplier invoice file is missing from storage');
  return { body: object.body, filename: file.name ?? 'invoice.pdf' };
}

export async function deleteSupplierInvoiceFile(pool, storage, id) {
  requireStorage(storage);
  await requireLivePurchase(pool, id);
  const file = await repository.findSupplierInvoiceFile(pool, id);
  if (file?.key) {
    await repository.clearSupplierInvoiceFile(pool, id);
    try {
      await storage.deleteObject(file.key);
    } catch (error) {
      console.warn('[storage] could not delete the supplier invoice object', { id, error: error.message });
    }
  }
  return { data: await repository.findByIdWithDetails(pool, id) };
}
