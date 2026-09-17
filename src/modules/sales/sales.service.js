import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { withIdempotency } from '../../shared/idempotency/idempotency.guard.js';
import { allocateFifo } from '../inventory/costing/fifo-allocator.js';
import * as repository from './sales.repository.js';
import * as outboundsRepository from '../inventory/outbounds/outbounds.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../inventory/costing/cost-allocations.repository.js';
import * as warehousesRepository from '../warehouses/warehouses.repository.js';
import * as contactsRepository from '../contacts/contacts.repository.js';
import * as paymentsRepository from '../payments/payments.repository.js';
import { assertItemsInScope, assertContactInScope } from '../../shared/auth/master-data-scope.js';
import { getBusinessUnitById } from '../../shared/auth/business-units-client.js';
import { buildReceipt } from './sales.receipt.js';

// Computed straight from the payload (not a DB round trip) — it's exactly
// what insertDetails/computeAndStoreTotals will independently derive from the
// rows they write moments later, so this is safe to validate against before
// anything is even inserted.
function assertDiscountWithinSubtotal(payload) {
  const discountAmount = payload.discount_amount ?? 0;
  if (discountAmount === 0) return;
  const subtotal = payload.details.reduce((sum, d) => sum + d.quantity * (d.unit_price ?? 0), 0);
  if (discountAmount > subtotal) {
    throw new BadRequestError(
      'DISCOUNT_EXCEEDS_SUBTOTAL',
      `discount_amount (${discountAmount}) cannot exceed the subtotal (${subtotal.toFixed(2)})`
    );
  }
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

export async function listSales(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    warehouseId: query.warehouse_id ?? null,
    status: query.status ?? null,
    held: query.held ?? null,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getSale(db, id) {
  const sale = await repository.findByIdWithDetails(db, id);
  if (!sale) throw new NotFoundError(`Sale ${id} not found`);
  return { data: sale };
}

// Print-ready receipt for a completed sale (2026-09-13) — see sales.receipt.js
// for the actual text/ESC-POS formatting; this just gathers the rows it needs.
// BU-scoping for :id is already enforced upstream by buScope() on the route,
// same as getSale() above — no extra check needed here.
export async function getSaleReceipt(db, id, config = null, paperWidthMm = 58) {
  const sale = await repository.findByIdWithDetails(db, id);
  if (!sale) throw new NotFoundError(`Sale ${id} not found`);
  if (sale.status !== 'COMPLETED') {
    throw new ConflictError('INVALID_STATUS', 'A receipt is only available for a COMPLETED sale');
  }

  const [warehouse, payments] = await Promise.all([
    warehousesRepository.findById(db, sale.warehouse_id),
    paymentsRepository.findByInvoiceId(db, id, { limit: 1000, offset: 0 })
  ]);
  const [businessUnit, customer] = await Promise.all([
    config && warehouse?.bu_id ? getBusinessUnitById(config, warehouse.bu_id) : null,
    sale.contact_id ? contactsRepository.findById(db, sale.contact_id) : null
  ]);

  const receipt = buildReceipt(sale, { warehouse, businessUnit, customer, payments, paperWidthMm });
  return { data: receipt };
}

export async function createSale(pool, payload, userId = null, buIds = null) {
  await assertReversalTarget(pool, payload.reversal_of_invoice_id, payload.reversal_reason);
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);
  assertDiscountWithinSubtotal(payload);
  const taxRate = payload.tax_rate ?? 0;
  const discountAmount = payload.discount_amount ?? 0;

  const id = await withTransaction(pool, async (connection) => {
    const invoiceId = await repository.insertHeader(connection, payload, userId);
    await repository.insertDetails(connection, invoiceId, payload.details);
    await repository.computeAndStoreTotals(connection, invoiceId, taxRate, discountAmount);
    return invoiceId;
  });

  const created = await repository.findByIdWithDetails(pool, id);
  return { data: created };
}

export async function updateSale(pool, id, payload, buIds = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Sale ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT sale can be updated');
  }
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);
  assertDiscountWithinSubtotal(payload);
  const taxRate = payload.tax_rate ?? 0;
  const discountAmount = payload.discount_amount ?? 0;

  await withTransaction(pool, async (connection) => {
    await repository.updateHeader(connection, id, payload);
    await repository.replaceDetails(connection, id, payload.details);
    await repository.computeAndStoreTotals(connection, id, taxRate, discountAmount);
  });

  const updated = await repository.findByIdWithDetails(pool, id);
  return { data: updated };
}

export async function deleteSale(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Sale ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT sale can be deleted');
  }

  await repository.remove(pool, id);
  return { data: { id: Number(id) } };
}

// Parks a DRAFT sale so the cashier can serve someone else without losing the
// cart — purely a marker on top of the existing DRAFT state (see the
// migration's comment), not a new state in the create->complete/cancel
// machine. Re-holding an already-held DRAFT just refreshes the timestamp/label.
export async function holdSale(pool, id, holdLabel = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Sale ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT sale can be held');
  }

  await repository.markHeld(pool, id, holdLabel);
  const held = await repository.findByIdWithDetails(pool, id);
  return { data: held };
}

export async function resumeSale(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Sale ${id} not found`);
  if (!existing.held_at) {
    throw new ConflictError('NOT_HELD', 'This sale is not currently on hold');
  }

  await repository.markResumed(pool, id);
  const resumed = await repository.findByIdWithDetails(pool, id);
  return { data: resumed };
}

export async function cancelSale(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Sale ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT sale can be cancelled');
  }

  await repository.markCancelled(pool, id);
  const cancelled = await repository.findByIdWithDetails(pool, id);
  return { data: cancelled };
}

export async function completeSale(pool, id, { idempotencyKey, endpoint, body, ttlHours, userId = null }) {
  return withTransaction(pool, (connection) =>
    withIdempotency(connection, { key: idempotencyKey, endpoint, body, ttlHours }, async () => {
      const sale = await repository.findByIdForUpdate(connection, id);
      if (!sale) throw new NotFoundError(`Sale ${id} not found`);
      if (sale.status !== 'DRAFT') {
        throw new ConflictError('INVALID_STATUS', 'Only a DRAFT sale can be completed');
      }

      const details = await repository.findDetails(connection, id);

      const transactionId = await outboundsRepository.insertHeader(connection, {
        warehouse_id: sale.warehouse_id,
        contact_id: sale.contact_id,
        transaction_date: sale.invoice_date,
        notes: `Sale ${sale.invoice_number}`
      }, userId);
      await outboundsRepository.insertDetails(
        connection,
        transactionId,
        details.map((detail) => ({ item_id: detail.item_id, quantity: detail.quantity, unit_price: detail.unit_price }))
      );

      for (const detail of details) {
        await stocksRepository.ensureRow(connection, sale.warehouse_id, detail.item_id);
        const stockRow = await stocksRepository.lockRow(connection, sale.warehouse_id, detail.item_id);

        if (stockRow.quantity < detail.quantity) {
          throw new ConflictError('INSUFFICIENT_STOCK', `Insufficient stock for item ${detail.item_id}`);
        }

        const allocations = await allocateFifo(connection, {
          warehouseId: sale.warehouse_id,
          itemId: detail.item_id,
          quantityNeeded: detail.quantity
        });

        const totalCost = allocations
          .reduce((sum, allocation) => sum + allocation.quantity * Number(allocation.unitCost), 0)
          .toFixed(2);

        const mutationId = await stockMutationsRepository.create(connection, {
          warehouse_id: sale.warehouse_id,
          item_id: detail.item_id,
          type: 'OUT',
          direction: 'OUT',
          quantity: detail.quantity,
          total_cost: totalCost,
          source_type: 'INVENTORY_TRANSACTION',
          source_id: transactionId,
          inventory_transaction_id: transactionId
        });

        let allocatedTotal = 0;
        for (const allocation of allocations) {
          await costLayersRepository.consume(connection, allocation.costLayerId, allocation.quantity);
          await costAllocationsRepository.create(connection, {
            consumption_mutation_id: mutationId,
            cost_layer_id: allocation.costLayerId,
            quantity: allocation.quantity,
            unit_cost: allocation.unitCost
          });
          allocatedTotal += allocation.quantity;
        }

        if (allocatedTotal !== detail.quantity) {
          throw new ConflictError('FIFO_ALLOCATION_MISMATCH', 'FIFO allocation quantity does not match mutation quantity');
        }

        await stocksRepository.decrement(connection, sale.warehouse_id, detail.item_id, detail.quantity);

        const unitCost = (Number(totalCost) / detail.quantity).toFixed(2);
        await repository.setDetailCost(connection, detail.id, { unit_cost: unitCost, cost_amount: totalCost });
      }

      await outboundsRepository.markCompleted(connection, transactionId, userId);
      await repository.markCompleted(connection, id, transactionId, userId);

      const completed = await repository.findByIdWithDetails(connection, id);
      return { statusCode: 200, body: { data: completed } };
    })
  );
}
