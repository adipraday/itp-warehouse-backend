import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { withIdempotency } from '../../shared/idempotency/idempotency.guard.js';
import * as repository from './purchases.repository.js';
import * as inboundsRepository from '../inventory/inbounds/inbounds.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../inventory/costing/cost-layers.repository.js';
import { assertItemsInScope, assertContactInScope } from '../../shared/auth/master-data-scope.js';

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

export async function listPurchases(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = { warehouseId: query.warehouse_id ?? null, status: query.status ?? null, buIds, assignedWarehouseIds };
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
    const invoiceId = await repository.insertHeader(connection, payload, userId);
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
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT purchase can be updated');
  }
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);
  const taxRate = payload.tax_rate ?? 0;

  await withTransaction(pool, async (connection) => {
    await repository.updateHeader(connection, id, payload);
    await repository.replaceDetails(connection, id, payload.details);
    await repository.computeAndStoreTotals(connection, id, taxRate);
  });

  const updated = await repository.findByIdWithDetails(pool, id);
  return { data: updated };
}

export async function deletePurchase(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Purchase ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT purchase can be deleted');
  }

  await repository.remove(pool, id);
  return { data: { id: Number(id) } };
}

export async function cancelPurchase(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Purchase ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT purchase can be cancelled');
  }

  await repository.markCancelled(pool, id);
  const cancelled = await repository.findByIdWithDetails(pool, id);
  return { data: cancelled };
}

export async function completePurchase(pool, id, { idempotencyKey, endpoint, body, ttlHours, userId = null }) {
  return withTransaction(pool, (connection) =>
    withIdempotency(connection, { key: idempotencyKey, endpoint, body, ttlHours }, async () => {
      const purchase = await repository.findByIdForUpdate(connection, id);
      if (!purchase) throw new NotFoundError(`Purchase ${id} not found`);
      if (purchase.status !== 'DRAFT') {
        throw new ConflictError('INVALID_STATUS', 'Only a DRAFT purchase can be completed');
      }

      const details = await repository.findDetails(connection, id);

      const transactionId = await inboundsRepository.insertHeader(connection, {
        warehouse_id: purchase.warehouse_id,
        contact_id: purchase.contact_id,
        transaction_date: purchase.invoice_date,
        notes: `Purchase ${purchase.invoice_number}`
      }, userId);
      await inboundsRepository.insertDetails(
        connection,
        transactionId,
        details.map((detail) => ({ item_id: detail.item_id, quantity: detail.quantity, unit_price: detail.unit_price }))
      );

      for (const detail of details) {
        await stocksRepository.ensureRow(connection, purchase.warehouse_id, detail.item_id);
        await stocksRepository.lockRow(connection, purchase.warehouse_id, detail.item_id);

        const totalCost = (detail.quantity * Number(detail.unit_price)).toFixed(2);

        const mutationId = await stockMutationsRepository.create(connection, {
          warehouse_id: purchase.warehouse_id,
          item_id: detail.item_id,
          type: 'IN',
          direction: 'IN',
          quantity: detail.quantity,
          total_cost: totalCost,
          source_type: 'INVENTORY_TRANSACTION',
          source_id: transactionId,
          inventory_transaction_id: transactionId
        });

        await costLayersRepository.create(connection, {
          warehouse_id: purchase.warehouse_id,
          item_id: detail.item_id,
          source_stock_mutation_id: mutationId,
          quantity_received: detail.quantity,
          quantity_remaining: detail.quantity,
          unit_cost: detail.unit_price
        });

        await stocksRepository.increment(connection, purchase.warehouse_id, detail.item_id, detail.quantity);
      }

      await inboundsRepository.markCompleted(connection, transactionId, userId);
      await repository.markCompleted(connection, id, transactionId, userId);

      const completed = await repository.findByIdWithDetails(connection, id);
      return { statusCode: 200, body: { data: completed } };
    })
  );
}
