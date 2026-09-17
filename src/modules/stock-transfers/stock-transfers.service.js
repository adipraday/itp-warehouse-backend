import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { withIdempotency } from '../../shared/idempotency/idempotency.guard.js';
import { allocateFifo } from '../inventory/costing/fifo-allocator.js';
import * as repository from './stock-transfers.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../inventory/costing/cost-allocations.repository.js';
import { assertItemsInScope } from '../../shared/auth/master-data-scope.js';

function assertDifferentWarehouses(payload) {
  if (payload.source_warehouse_id === payload.destination_warehouse_id) {
    throw new BadRequestError('SAME_WAREHOUSE', 'source_warehouse_id and destination_warehouse_id must differ');
  }
}

async function assertReversalTarget(db, reversalOfTransferId, reversalReason) {
  if (!reversalOfTransferId) return;
  if (!reversalReason) {
    throw new BadRequestError('REVERSAL_REASON_REQUIRED', 'reversal_reason is required when reversal_of_transfer_id is set');
  }
  const original = await repository.findById(db, reversalOfTransferId);
  if (!original || original.status !== 'COMPLETED') {
    throw new BadRequestError('INVALID_REVERSAL_TARGET', 'reversal_of_transfer_id must reference a COMPLETED stock transfer');
  }
}

export async function listStockTransfers(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    sourceWarehouseId: query.source_warehouse_id ?? null,
    destinationWarehouseId: query.destination_warehouse_id ?? null,
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

export async function getStockTransfer(db, id) {
  const transfer = await repository.findByIdWithDetails(db, id);
  if (!transfer) throw new NotFoundError(`Stock transfer ${id} not found`);
  return { data: transfer };
}

export async function createStockTransfer(pool, payload, userId = null, buIds = null) {
  assertDifferentWarehouses(payload);
  await assertReversalTarget(pool, payload.reversal_of_transfer_id, payload.reversal_reason);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);

  const id = await withTransaction(pool, async (connection) => {
    const transferId = await repository.insertHeader(connection, payload, userId);
    await repository.insertDetails(connection, transferId, payload.details);
    return transferId;
  });

  const created = await repository.findByIdWithDetails(pool, id);
  return { data: created };
}

export async function updateStockTransfer(pool, id, payload, buIds = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock transfer ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT stock transfer can be updated');
  }
  assertDifferentWarehouses(payload);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);

  await withTransaction(pool, async (connection) => {
    await repository.updateHeader(connection, id, payload);
    await repository.replaceDetails(connection, id, payload.details);
  });

  const updated = await repository.findByIdWithDetails(pool, id);
  return { data: updated };
}

export async function deleteStockTransfer(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock transfer ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT stock transfer can be deleted');
  }

  await repository.remove(pool, id);
  return { data: { id: Number(id) } };
}

export async function approveStockTransfer(pool, id, userId = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock transfer ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT stock transfer can be approved');
  }

  await repository.markApproved(pool, id, userId);
  const approved = await repository.findByIdWithDetails(pool, id);
  return { data: approved };
}

export async function cancelStockTransfer(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock transfer ${id} not found`);
  if (existing.status !== 'DRAFT' && existing.status !== 'APPROVED') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT or APPROVED stock transfer can be cancelled');
  }

  await repository.markCancelled(pool, id);
  const cancelled = await repository.findByIdWithDetails(pool, id);
  return { data: cancelled };
}

export async function completeStockTransfer(pool, id, { idempotencyKey, endpoint, body, ttlHours, userId = null }) {
  return withTransaction(pool, (connection) =>
    withIdempotency(connection, { key: idempotencyKey, endpoint, body, ttlHours }, async () => {
      const transfer = await repository.findByIdForUpdate(connection, id);
      if (!transfer) throw new NotFoundError(`Stock transfer ${id} not found`);
      if (transfer.status !== 'APPROVED') {
        throw new ConflictError('INVALID_STATUS', 'Only an APPROVED stock transfer can be completed');
      }

      const details = await repository.findDetails(connection, id);

      for (const detail of details) {
        await stocksRepository.ensureRow(connection, transfer.source_warehouse_id, detail.item_id);
        const sourceStock = await stocksRepository.lockRow(connection, transfer.source_warehouse_id, detail.item_id);

        if (sourceStock.quantity < detail.quantity) {
          throw new ConflictError('INSUFFICIENT_STOCK', `Insufficient stock for item ${detail.item_id} at the source warehouse`);
        }

        const allocations = await allocateFifo(connection, {
          warehouseId: transfer.source_warehouse_id,
          itemId: detail.item_id,
          quantityNeeded: detail.quantity
        });

        const totalCost = allocations
          .reduce((sum, allocation) => sum + allocation.quantity * Number(allocation.unitCost), 0)
          .toFixed(2);

        const outMutationId = await stockMutationsRepository.create(connection, {
          warehouse_id: transfer.source_warehouse_id,
          item_id: detail.item_id,
          type: 'OUT',
          direction: 'OUT',
          quantity: detail.quantity,
          total_cost: totalCost,
          source_type: 'STOCK_TRANSFER',
          source_id: transfer.id,
          stock_transfer_id: transfer.id
        });

        let allocatedTotal = 0;
        for (const allocation of allocations) {
          await costLayersRepository.consume(connection, allocation.costLayerId, allocation.quantity);
          await costAllocationsRepository.create(connection, {
            consumption_mutation_id: outMutationId,
            cost_layer_id: allocation.costLayerId,
            quantity: allocation.quantity,
            unit_cost: allocation.unitCost
          });
          allocatedTotal += allocation.quantity;
        }

        if (allocatedTotal !== detail.quantity) {
          throw new ConflictError('FIFO_ALLOCATION_MISMATCH', 'FIFO allocation quantity does not match mutation quantity');
        }

        await stocksRepository.decrement(connection, transfer.source_warehouse_id, detail.item_id, detail.quantity);

        await stocksRepository.ensureRow(connection, transfer.destination_warehouse_id, detail.item_id);
        await stocksRepository.lockRow(connection, transfer.destination_warehouse_id, detail.item_id);

        const inMutationId = await stockMutationsRepository.create(connection, {
          warehouse_id: transfer.destination_warehouse_id,
          item_id: detail.item_id,
          type: 'IN',
          direction: 'IN',
          quantity: detail.quantity,
          total_cost: totalCost,
          source_type: 'STOCK_TRANSFER',
          source_id: transfer.id,
          stock_transfer_id: transfer.id
        });

        for (const allocation of allocations) {
          await costLayersRepository.create(connection, {
            warehouse_id: transfer.destination_warehouse_id,
            item_id: detail.item_id,
            source_stock_mutation_id: inMutationId,
            origin_cost_layer_id: allocation.costLayerId,
            quantity_received: allocation.quantity,
            quantity_remaining: allocation.quantity,
            unit_cost: allocation.unitCost
          });
        }

        await stocksRepository.increment(connection, transfer.destination_warehouse_id, detail.item_id, detail.quantity);
      }

      await repository.markCompleted(connection, id, userId);
      const completed = await repository.findByIdWithDetails(connection, id);

      return { statusCode: 200, body: { data: completed } };
    })
  );
}
