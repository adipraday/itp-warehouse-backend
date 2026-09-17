import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { withIdempotency } from '../../shared/idempotency/idempotency.guard.js';
import { allocateFifo } from '../inventory/costing/fifo-allocator.js';
import * as repository from './stock-opnames.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../inventory/costing/cost-allocations.repository.js';
import { assertItemsInScope } from '../../shared/auth/master-data-scope.js';

async function assertReversalTarget(db, reversalOfStockOpnameId, reversalReason) {
  if (!reversalOfStockOpnameId) return;
  if (!reversalReason) {
    throw new BadRequestError(
      'REVERSAL_REASON_REQUIRED',
      'reversal_reason is required when reversal_of_stock_opname_id is set'
    );
  }
  const original = await repository.findById(db, reversalOfStockOpnameId);
  if (!original || original.status !== 'APPROVED') {
    throw new BadRequestError('INVALID_REVERSAL_TARGET', 'reversal_of_stock_opname_id must reference an APPROVED stock opname');
  }
}

export async function listStockOpnames(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = { warehouseId: query.warehouse_id ?? null, status: query.status ?? null, buIds, assignedWarehouseIds };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getStockOpname(db, id) {
  const opname = await repository.findByIdWithDetails(db, id);
  if (!opname) throw new NotFoundError(`Stock opname ${id} not found`);
  return { data: opname };
}

export async function createStockOpname(pool, payload, userId = null, buIds = null) {
  await assertReversalTarget(pool, payload.reversal_of_stock_opname_id, payload.reversal_reason);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);

  const id = await withTransaction(pool, async (connection) => {
    const opnameId = await repository.insertHeader(connection, payload, userId);
    await repository.insertDetails(connection, opnameId, payload.warehouse_id, payload.details);
    return opnameId;
  });

  const created = await repository.findByIdWithDetails(pool, id);
  return { data: created };
}

export async function updateStockOpname(pool, id, payload, buIds = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock opname ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT stock opname can be updated');
  }
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);

  await withTransaction(pool, async (connection) => {
    await repository.updateHeader(connection, id, payload);
    await repository.replaceDetails(connection, id, payload.warehouse_id, payload.details);
  });

  const updated = await repository.findByIdWithDetails(pool, id);
  return { data: updated };
}

export async function deleteStockOpname(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock opname ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT stock opname can be deleted');
  }

  await repository.remove(pool, id);
  return { data: { id: Number(id) } };
}

export async function submitStockOpname(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock opname ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT stock opname can be submitted');
  }

  await repository.markSubmitted(pool, id);
  const submitted = await repository.findByIdWithDetails(pool, id);
  return { data: submitted };
}

export async function cancelStockOpname(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Stock opname ${id} not found`);
  if (existing.status !== 'DRAFT' && existing.status !== 'SUBMITTED') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT or SUBMITTED stock opname can be cancelled');
  }

  await repository.markCancelled(pool, id);
  const cancelled = await repository.findByIdWithDetails(pool, id);
  return { data: cancelled };
}

export async function approveStockOpname(pool, id, { idempotencyKey, endpoint, body, ttlHours, userId = null }) {
  return withTransaction(pool, (connection) =>
    withIdempotency(connection, { key: idempotencyKey, endpoint, body, ttlHours }, async () => {
      const opname = await repository.findByIdForUpdate(connection, id);
      if (!opname) throw new NotFoundError(`Stock opname ${id} not found`);
      if (opname.status !== 'SUBMITTED') {
        throw new ConflictError('INVALID_STATUS', 'Only a SUBMITTED stock opname can be approved');
      }

      const details = await repository.findDetails(connection, id);

      for (const detail of details) {
        if (detail.difference === 0) continue;

        await stocksRepository.ensureRow(connection, opname.warehouse_id, detail.item_id);

        if (detail.difference > 0) {
          const mutationId = await stockMutationsRepository.create(connection, {
            warehouse_id: opname.warehouse_id,
            item_id: detail.item_id,
            type: 'ADJUSTMENT',
            direction: 'IN',
            quantity: detail.difference,
            total_cost: '0.00',
            source_type: 'STOCK_OPNAME',
            source_id: opname.id,
            stock_opname_id: opname.id
          });

          await costLayersRepository.create(connection, {
            warehouse_id: opname.warehouse_id,
            item_id: detail.item_id,
            source_stock_mutation_id: mutationId,
            quantity_received: detail.difference,
            quantity_remaining: detail.difference,
            unit_cost: 0
          });

          await stocksRepository.increment(connection, opname.warehouse_id, detail.item_id, detail.difference);
        } else {
          const quantityNeeded = Math.abs(detail.difference);
          const stockRow = await stocksRepository.lockRow(connection, opname.warehouse_id, detail.item_id);

          if (stockRow.quantity < quantityNeeded) {
            throw new ConflictError(
              'INSUFFICIENT_STOCK',
              `Insufficient stock for item ${detail.item_id} to post the opname shortage`
            );
          }

          const allocations = await allocateFifo(connection, {
            warehouseId: opname.warehouse_id,
            itemId: detail.item_id,
            quantityNeeded
          });

          const totalCost = allocations
            .reduce((sum, allocation) => sum + allocation.quantity * Number(allocation.unitCost), 0)
            .toFixed(2);

          const mutationId = await stockMutationsRepository.create(connection, {
            warehouse_id: opname.warehouse_id,
            item_id: detail.item_id,
            type: 'ADJUSTMENT',
            direction: 'OUT',
            quantity: quantityNeeded,
            total_cost: totalCost,
            source_type: 'STOCK_OPNAME',
            source_id: opname.id,
            stock_opname_id: opname.id
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

          if (allocatedTotal !== quantityNeeded) {
            throw new ConflictError('FIFO_ALLOCATION_MISMATCH', 'FIFO allocation quantity does not match mutation quantity');
          }

          await stocksRepository.decrement(connection, opname.warehouse_id, detail.item_id, quantityNeeded);
        }
      }

      await repository.markApproved(connection, id, userId);
      const approved = await repository.findByIdWithDetails(connection, id);

      return { statusCode: 200, body: { data: approved } };
    })
  );
}
