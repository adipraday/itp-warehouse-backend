import { NotFoundError, ConflictError, BadRequestError } from '../../../shared/errors/app-error.js';
import { parsePagination } from '../../../shared/utils/pagination.js';
import { withTransaction } from '../../../shared/database/transaction.js';
import { withIdempotency } from '../../../shared/idempotency/idempotency.guard.js';
import { assertItemsInScope, assertContactInScope } from '../../../shared/auth/master-data-scope.js';
import * as repository from './inbounds.repository.js';
import * as stocksRepository from '../stocks/stocks.repository.js';
import * as stockMutationsRepository from '../stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../costing/cost-layers.repository.js';

async function assertReversalTarget(db, reversalOfTransactionId, reversalReason) {
  if (!reversalOfTransactionId) return;
  if (!reversalReason) {
    throw new BadRequestError('REVERSAL_REASON_REQUIRED', 'reversal_reason is required when reversal_of_transaction_id is set');
  }
  const original = await repository.findAnyById(db, reversalOfTransactionId);
  if (!original || original.status !== 'COMPLETED') {
    throw new BadRequestError('INVALID_REVERSAL_TARGET', 'reversal_of_transaction_id must reference a COMPLETED transaction');
  }
}

export async function listInbounds(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    warehouseId: query.warehouse_id ?? null,
    status: query.status ?? null,
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

export async function getInbound(db, id) {
  const inbound = await repository.findByIdWithDetails(db, id);
  if (!inbound) throw new NotFoundError(`Inbound ${id} not found`);
  return { data: inbound };
}

export async function createInbound(pool, payload, userId = null, buIds = null) {
  await assertReversalTarget(pool, payload.reversal_of_transaction_id, payload.reversal_reason);
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);

  const id = await withTransaction(pool, async (connection) => {
    const transactionId = await repository.insertHeader(connection, payload, userId);
    await repository.insertDetails(connection, transactionId, payload.details);
    return transactionId;
  });

  const created = await repository.findByIdWithDetails(pool, id);
  return { data: created };
}

export async function updateInbound(pool, id, payload, buIds = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Inbound ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT inbound can be updated');
  }
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);

  await withTransaction(pool, async (connection) => {
    await repository.updateHeader(connection, id, payload);
    await repository.replaceDetails(connection, id, payload.details);
  });

  const updated = await repository.findByIdWithDetails(pool, id);
  return { data: updated };
}

export async function deleteInbound(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Inbound ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT inbound can be deleted');
  }

  await repository.remove(pool, id);
  return { data: { id: Number(id) } };
}

export async function cancelInbound(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Inbound ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT inbound can be cancelled');
  }

  await repository.markCancelled(pool, id);
  const cancelled = await repository.findByIdWithDetails(pool, id);
  return { data: cancelled };
}

export async function completeInbound(pool, id, { idempotencyKey, endpoint, body, ttlHours, userId = null }) {
  return withTransaction(pool, (connection) =>
    withIdempotency(connection, { key: idempotencyKey, endpoint, body, ttlHours }, async () => {
      const transaction = await repository.findByIdForUpdate(connection, id);
      if (!transaction) throw new NotFoundError(`Inbound ${id} not found`);
      if (transaction.status !== 'DRAFT') {
        throw new ConflictError('INVALID_STATUS', 'Only a DRAFT inbound can be completed');
      }

      const details = await repository.findDetails(connection, id);

      for (const detail of details) {
        await stocksRepository.ensureRow(connection, transaction.warehouse_id, detail.item_id);
        await stocksRepository.lockRow(connection, transaction.warehouse_id, detail.item_id);

        const totalCost = (detail.quantity * Number(detail.unit_price)).toFixed(2);

        const mutationId = await stockMutationsRepository.create(connection, {
          warehouse_id: transaction.warehouse_id,
          item_id: detail.item_id,
          type: 'IN',
          direction: 'IN',
          quantity: detail.quantity,
          total_cost: totalCost,
          source_type: 'INVENTORY_TRANSACTION',
          source_id: transaction.id,
          inventory_transaction_id: transaction.id
        });

        await costLayersRepository.create(connection, {
          warehouse_id: transaction.warehouse_id,
          item_id: detail.item_id,
          source_stock_mutation_id: mutationId,
          quantity_received: detail.quantity,
          quantity_remaining: detail.quantity,
          unit_cost: detail.unit_price
        });

        await stocksRepository.increment(connection, transaction.warehouse_id, detail.item_id, detail.quantity);
      }

      await repository.markCompleted(connection, id, userId);
      const completed = await repository.findByIdWithDetails(connection, id);

      return { statusCode: 200, body: { data: completed } };
    })
  );
}
