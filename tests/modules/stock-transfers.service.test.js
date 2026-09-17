import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/stock-transfers/stock-transfers.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../../src/modules/inventory/costing/cost-allocations.repository.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/stock-transfers/stock-transfers.service.js';

vi.mock('../../src/modules/stock-transfers/stock-transfers.repository.js');
vi.mock('../../src/modules/inventory/stocks/stocks.repository.js');
vi.mock('../../src/modules/inventory/stock-mutations/stock-mutations.repository.js');
vi.mock('../../src/modules/inventory/costing/cost-layers.repository.js');
vi.mock('../../src/modules/inventory/costing/cost-allocations.repository.js');
vi.mock('../../src/shared/idempotency/idempotency.repository.js');
vi.mock('../../src/shared/database/transaction.js', () => ({
  withTransaction: vi.fn((pool, work) => work({}))
}));

const fakePool = {};

function freshIdempotencyRecord() {
  idempotencyRepository.getOrCreate.mockImplementation(async (connection, { key, endpoint, requestHash }) => ({
    id: 1,
    idempotency_key: key,
    endpoint,
    request_hash: requestHash,
    status: 'PROCESSING',
    response_code: null,
    response_body: null
  }));
  idempotencyRepository.markCompleted.mockResolvedValue();
}

const idempotencyOptions = { idempotencyKey: 'key-1', endpoint: 'POST /api/stock-transfers/1/complete', body: {}, ttlHours: 24 };

describe('stock-transfers.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('createStockTransfer rejects when source and destination warehouses are the same', async () => {
    const payload = {
      source_warehouse_id: 1,
      destination_warehouse_id: 1,
      transfer_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 5 }]
    };

    await expect(service.createStockTransfer(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'SAME_WAREHOUSE'
    });
    expect(repository.insertHeader).not.toHaveBeenCalled();
  });

  it('createStockTransfer inserts the header and its details', async () => {
    repository.insertHeader.mockResolvedValue(1);
    repository.insertDetails.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, transfer_number: 'TRF-000001' });

    const payload = {
      source_warehouse_id: 1,
      destination_warehouse_id: 2,
      transfer_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 5 }]
    };
    const result = await service.createStockTransfer(fakePool, payload);

    expect(repository.insertHeader).toHaveBeenCalledWith(expect.anything(), payload, null);
    expect(result).toEqual({ data: { id: 1, transfer_number: 'TRF-000001' } });
  });

  it('approveStockTransfer rejects when the transfer is not DRAFT', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'APPROVED' });

    await expect(service.approveStockTransfer(fakePool, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
  });

  it('cancelStockTransfer allows cancellation from APPROVED', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'APPROVED' });
    repository.markCancelled.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'CANCELLED' });

    const result = await service.cancelStockTransfer(fakePool, 1);

    expect(result).toEqual({ data: { id: 1, status: 'CANCELLED' } });
  });

  it('cancelStockTransfer rejects cancellation from COMPLETED', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await expect(service.cancelStockTransfer(fakePool, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
  });

  it('completeStockTransfer moves FIFO value from the source to the destination warehouse without revenue/COGS', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, source_warehouse_id: 1, destination_warehouse_id: 2, status: 'APPROVED' });
    repository.findDetails.mockResolvedValue([{ item_id: 1, quantity: 4 }]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 10 });
    costLayersRepository.lockAvailableLayers.mockResolvedValue([{ id: 7, quantity_remaining: 10, unit_cost: '50000.00' }]);
    stockMutationsRepository.create.mockResolvedValueOnce(101).mockResolvedValueOnce(102);
    costLayersRepository.consume.mockResolvedValue();
    costAllocationsRepository.create.mockResolvedValue();
    costLayersRepository.create.mockResolvedValue(201);
    stocksRepository.decrement.mockResolvedValue();
    stocksRepository.increment.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    const result = await service.completeStockTransfer(fakePool, 1, idempotencyOptions);

    expect(stockMutationsRepository.create).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ warehouse_id: 1, type: 'OUT', direction: 'OUT', quantity: 4, total_cost: '200000.00' })
    );
    expect(stockMutationsRepository.create).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ warehouse_id: 2, type: 'IN', direction: 'IN', quantity: 4, total_cost: '200000.00' })
    );
    expect(costLayersRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        warehouse_id: 2,
        item_id: 1,
        origin_cost_layer_id: 7,
        quantity_received: 4,
        quantity_remaining: 4,
        unit_cost: '50000.00'
      })
    );
    expect(stocksRepository.decrement).toHaveBeenCalledWith(expect.anything(), 1, 1, 4);
    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 2, 1, 4);
    expect(result.statusCode).toBe(200);
  });

  it('completeStockTransfer rejects when the source warehouse lacks enough stock', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, source_warehouse_id: 1, destination_warehouse_id: 2, status: 'APPROVED' });
    repository.findDetails.mockResolvedValue([{ item_id: 1, quantity: 100 }]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 3 });

    await expect(service.completeStockTransfer(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK'
    });
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
  });

  it('completeStockTransfer rejects when the transfer is not APPROVED', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, source_warehouse_id: 1, destination_warehouse_id: 2, status: 'DRAFT' });

    await expect(service.completeStockTransfer(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
  });
});

// Regression coverage for the 2026-09-08 cross-tenant leak.
describe('stock-transfers.service — item bu_id scoping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects a detail line whose item is outside the caller\'s business units', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ id: 1, bu_id: 99 }]]) };
    const payload = {
      source_warehouse_id: 1,
      destination_warehouse_id: 2,
      transfer_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 5 }]
    };

    await expect(service.createStockTransfer(pool, payload, null, [11])).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
    expect(repository.insertHeader).not.toHaveBeenCalled();
  });

  it('passes when the referenced item is in scope', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ id: 1, bu_id: 11 }]]) };
    repository.insertHeader.mockResolvedValue(1);
    repository.insertDetails.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1 });
    const payload = {
      source_warehouse_id: 1,
      destination_warehouse_id: 2,
      transfer_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 5 }]
    };

    await expect(service.createStockTransfer(pool, payload, null, [11])).resolves.toMatchObject({ data: { id: 1 } });
  });
});
