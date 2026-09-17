import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { withIdempotency } from '../../shared/idempotency/idempotency.guard.js';
import { allocateFifo } from '../inventory/costing/fifo-allocator.js';
import * as repository from './returns.repository.js';
import * as invoicesRepository from '../invoices/invoices.repository.js';
import * as inboundsRepository from '../inventory/inbounds/inbounds.repository.js';
import * as outboundsRepository from '../inventory/outbounds/outbounds.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../inventory/costing/cost-allocations.repository.js';
import { assertItemsInScope, assertContactInScope } from '../../shared/auth/master-data-scope.js';

// Validates the origin document and every line, then returns the details
// enriched with a backend-derived unit_cost (never a client-supplied value).
async function assertOriginAndBuildDetails(db, { type, original_invoice_id, original_inventory_transaction_id, details }) {
  const hasInvoice = Boolean(original_invoice_id);
  const hasTransaction = Boolean(original_inventory_transaction_id);

  if (hasInvoice === hasTransaction) {
    throw new BadRequestError(
      'EXACTLY_ONE_ORIGIN_REQUIRED',
      'Exactly one of original_invoice_id or original_inventory_transaction_id must be set'
    );
  }
  if (type === 'RETURN_CUSTOMER' && !hasInvoice) {
    throw new BadRequestError('INVALID_ORIGIN_FOR_TYPE', 'RETURN_CUSTOMER requires original_invoice_id');
  }
  if (type === 'RETURN_SUPPLIER' && !hasTransaction) {
    throw new BadRequestError('INVALID_ORIGIN_FOR_TYPE', 'RETURN_SUPPLIER requires original_inventory_transaction_id');
  }

  if (hasInvoice) {
    const invoice = await invoicesRepository.findById(db, original_invoice_id);
    if (!invoice || invoice.type !== 'SALES' || invoice.status !== 'COMPLETED') {
      throw new BadRequestError('INVALID_ORIGIN_DOCUMENT', 'original_invoice_id must reference a COMPLETED SALES invoice');
    }
  } else {
    const transaction = await inboundsRepository.findAnyById(db, original_inventory_transaction_id);
    if (!transaction || transaction.type !== 'INBOUND' || transaction.status !== 'COMPLETED') {
      throw new BadRequestError(
        'INVALID_ORIGIN_DOCUMENT',
        'original_inventory_transaction_id must reference a COMPLETED INBOUND transaction'
      );
    }
  }

  const enriched = [];
  for (const detail of details) {
    if (detail.condition === 'DAMAGED' && detail.action !== 'SCRAP') {
      throw new BadRequestError('DAMAGED_MUST_BE_SCRAPPED', `Item ${detail.item_id}: a DAMAGED item must use action SCRAP`);
    }
    if (detail.action === 'REPLACE' && (type !== 'RETURN_CUSTOMER' || detail.condition !== 'GOOD')) {
      throw new BadRequestError(
        'INVALID_REPLACE_ACTION',
        `Item ${detail.item_id}: REPLACE is only valid for RETURN_CUSTOMER with condition GOOD`
      );
    }

    const originLine = hasInvoice
      ? await repository.findInvoiceLine(db, original_invoice_id, detail.item_id)
      : await repository.findTransactionLine(db, original_inventory_transaction_id, detail.item_id);

    if (!originLine) {
      throw new BadRequestError('ITEM_NOT_ON_ORIGINAL_DOCUMENT', `Item ${detail.item_id} is not on the original document`);
    }

    const alreadyReturned = hasInvoice
      ? await repository.sumReturnedQuantityForInvoice(db, original_invoice_id, detail.item_id)
      : await repository.sumReturnedQuantityForTransaction(db, original_inventory_transaction_id, detail.item_id);

    const eligible = originLine.quantity - alreadyReturned;
    if (detail.quantity > eligible) {
      throw new ConflictError(
        'RETURN_QUANTITY_EXCEEDS_ELIGIBLE',
        `Item ${detail.item_id}: return quantity exceeds the eligible remaining quantity of ${eligible}`
      );
    }

    const unitCost = hasInvoice ? originLine.unit_cost : originLine.unit_price;
    enriched.push({ ...detail, unit_cost: unitCost });
  }

  return enriched;
}

export async function listItemReturns(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    warehouseId: query.warehouse_id ?? null,
    type: query.type ?? null,
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

export async function getItemReturn(db, id) {
  const itemReturn = await repository.findByIdWithDetails(db, id);
  if (!itemReturn) throw new NotFoundError(`Return ${id} not found`);
  return { data: itemReturn };
}

export async function createItemReturn(pool, payload, userId = null, buIds = null) {
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);
  const enrichedDetails = await assertOriginAndBuildDetails(pool, payload);

  const id = await withTransaction(pool, async (connection) => {
    const returnId = await repository.insertHeader(connection, payload, userId);
    await repository.insertDetails(connection, returnId, enrichedDetails);
    return returnId;
  });

  const created = await repository.findByIdWithDetails(pool, id);
  return { data: created };
}

export async function updateItemReturn(pool, id, payload, buIds = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Return ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT return can be updated');
  }
  await assertContactInScope(pool, payload.contact_id, buIds);
  await assertItemsInScope(pool, payload.details.map((d) => d.item_id), buIds);

  const enrichedDetails = await assertOriginAndBuildDetails(pool, {
    type: existing.type,
    original_invoice_id: existing.original_invoice_id,
    original_inventory_transaction_id: existing.original_inventory_transaction_id,
    details: payload.details
  });

  await withTransaction(pool, async (connection) => {
    await repository.updateHeader(connection, id, payload);
    await repository.replaceDetails(connection, id, enrichedDetails);
  });

  const updated = await repository.findByIdWithDetails(pool, id);
  return { data: updated };
}

export async function deleteItemReturn(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Return ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT return can be deleted');
  }

  await repository.remove(pool, id);
  return { data: { id: Number(id) } };
}

export async function approveItemReturn(pool, id, userId = null) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Return ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT return can be approved');
  }

  await repository.markApproved(pool, id, userId);
  const approved = await repository.findByIdWithDetails(pool, id);
  return { data: approved };
}

export async function rejectItemReturn(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Return ${id} not found`);
  if (existing.status !== 'DRAFT' && existing.status !== 'APPROVED') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT or APPROVED return can be rejected');
  }

  await repository.markRejected(pool, id);
  const rejected = await repository.findByIdWithDetails(pool, id);
  return { data: rejected };
}

export async function cancelItemReturn(pool, id) {
  const existing = await repository.findById(pool, id);
  if (!existing) throw new NotFoundError(`Return ${id} not found`);
  if (existing.status !== 'DRAFT' && existing.status !== 'APPROVED') {
    throw new ConflictError('INVALID_STATUS', 'Only a DRAFT or APPROVED return can be cancelled');
  }

  await repository.markCancelled(pool, id);
  const cancelled = await repository.findByIdWithDetails(pool, id);
  return { data: cancelled };
}

// GOOD (RESTOCK or REPLACE) lines return to stock at their historical cost.
// DAMAGED (SCRAP) lines are skipped entirely: no stock, mutation, or cost layer.
// Returns the replacement OUTBOUND transaction id, or null if no REPLACE lines exist.
async function completeCustomerReturn(connection, itemReturn, details, userId) {
  const replacementLines = [];

  for (const detail of details) {
    if (detail.condition === 'DAMAGED') continue;

    await stocksRepository.ensureRow(connection, itemReturn.warehouse_id, detail.item_id);
    await stocksRepository.lockRow(connection, itemReturn.warehouse_id, detail.item_id);

    const mutationId = await stockMutationsRepository.create(connection, {
      warehouse_id: itemReturn.warehouse_id,
      item_id: detail.item_id,
      type: 'RETURN_IN',
      direction: 'IN',
      quantity: detail.quantity,
      total_cost: detail.total_cost,
      source_type: 'RETURN',
      source_id: itemReturn.id,
      return_id: itemReturn.id
    });

    await costLayersRepository.create(connection, {
      warehouse_id: itemReturn.warehouse_id,
      item_id: detail.item_id,
      source_stock_mutation_id: mutationId,
      quantity_received: detail.quantity,
      quantity_remaining: detail.quantity,
      unit_cost: detail.unit_cost
    });

    await stocksRepository.increment(connection, itemReturn.warehouse_id, detail.item_id, detail.quantity);

    if (detail.action === 'REPLACE') {
      replacementLines.push({ item_id: detail.item_id, quantity: detail.quantity, unit_price: 0 });
    }
  }

  if (replacementLines.length === 0) return null;

  const replacementTransactionId = await outboundsRepository.insertHeader(connection, {
    warehouse_id: itemReturn.warehouse_id,
    contact_id: itemReturn.contact_id,
    transaction_date: itemReturn.return_date,
    notes: `Replacement for return ${itemReturn.return_number}`
  }, userId);
  await outboundsRepository.insertDetails(connection, replacementTransactionId, replacementLines);

  for (const line of replacementLines) {
    await stocksRepository.ensureRow(connection, itemReturn.warehouse_id, line.item_id);
    const stockRow = await stocksRepository.lockRow(connection, itemReturn.warehouse_id, line.item_id);

    if (stockRow.quantity < line.quantity) {
      throw new ConflictError('INSUFFICIENT_STOCK', `Insufficient replacement stock for item ${line.item_id}`);
    }

    const allocations = await allocateFifo(connection, {
      warehouseId: itemReturn.warehouse_id,
      itemId: line.item_id,
      quantityNeeded: line.quantity
    });

    const totalCost = allocations
      .reduce((sum, allocation) => sum + allocation.quantity * Number(allocation.unitCost), 0)
      .toFixed(2);

    const mutationId = await stockMutationsRepository.create(connection, {
      warehouse_id: itemReturn.warehouse_id,
      item_id: line.item_id,
      type: 'OUT',
      direction: 'OUT',
      quantity: line.quantity,
      total_cost: totalCost,
      source_type: 'INVENTORY_TRANSACTION',
      source_id: replacementTransactionId,
      inventory_transaction_id: replacementTransactionId
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

    if (allocatedTotal !== line.quantity) {
      throw new ConflictError('FIFO_ALLOCATION_MISMATCH', 'FIFO allocation quantity does not match mutation quantity');
    }

    await stocksRepository.decrement(connection, itemReturn.warehouse_id, line.item_id, line.quantity);
  }

  await outboundsRepository.markCompleted(connection, replacementTransactionId, userId);
  return replacementTransactionId;
}

// Every supplier-return line leaves stock via FIFO, regardless of condition/action.
async function completeSupplierReturn(connection, itemReturn, details) {
  for (const detail of details) {
    await stocksRepository.ensureRow(connection, itemReturn.warehouse_id, detail.item_id);
    const stockRow = await stocksRepository.lockRow(connection, itemReturn.warehouse_id, detail.item_id);

    if (stockRow.quantity < detail.quantity) {
      throw new ConflictError('INSUFFICIENT_STOCK', `Insufficient stock for item ${detail.item_id}`);
    }

    const allocations = await allocateFifo(connection, {
      warehouseId: itemReturn.warehouse_id,
      itemId: detail.item_id,
      quantityNeeded: detail.quantity
    });

    const totalCost = allocations
      .reduce((sum, allocation) => sum + allocation.quantity * Number(allocation.unitCost), 0)
      .toFixed(2);

    const mutationId = await stockMutationsRepository.create(connection, {
      warehouse_id: itemReturn.warehouse_id,
      item_id: detail.item_id,
      type: 'RETURN_OUT',
      direction: 'OUT',
      quantity: detail.quantity,
      total_cost: totalCost,
      source_type: 'RETURN',
      source_id: itemReturn.id,
      return_id: itemReturn.id
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

    await stocksRepository.decrement(connection, itemReturn.warehouse_id, detail.item_id, detail.quantity);
  }

  return null;
}

export async function completeItemReturn(pool, id, { idempotencyKey, endpoint, body, ttlHours, userId = null }) {
  return withTransaction(pool, (connection) =>
    withIdempotency(connection, { key: idempotencyKey, endpoint, body, ttlHours }, async () => {
      const itemReturn = await repository.findByIdForUpdate(connection, id);
      if (!itemReturn) throw new NotFoundError(`Return ${id} not found`);
      if (itemReturn.status !== 'APPROVED') {
        throw new ConflictError('INVALID_STATUS', 'Only an APPROVED return can be completed');
      }

      const details = await repository.findDetails(connection, id);

      const replacementTransactionId =
        itemReturn.type === 'RETURN_CUSTOMER'
          ? await completeCustomerReturn(connection, itemReturn, details, userId)
          : await completeSupplierReturn(connection, itemReturn, details);

      await repository.markCompleted(connection, id, replacementTransactionId, userId);
      const completed = await repository.findByIdWithDetails(connection, id);

      return { statusCode: 200, body: { data: completed } };
    })
  );
}
