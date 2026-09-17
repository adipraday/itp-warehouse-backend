import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/inventory/outbounds/outbounds.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../../src/modules/inventory/costing/cost-allocations.repository.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/inventory/outbounds/outbounds.service.js';

vi.mock('../../src/modules/inventory/outbounds/outbounds.repository.js');
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

const idempotencyOptions = { idempotencyKey: 'key-1', endpoint: 'POST /api/outbounds/1/complete', body: {}, ttlHours: 24 };

describe('outbounds.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('completeOutbound consumes a single FIFO layer when it fully covers the quantity', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 2, status: 'DRAFT' });
    repository.findDetails.mockResolvedValue([{ item_id: 1, quantity: 4 }]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 10 });
    costLayersRepository.lockAvailableLayers.mockResolvedValue([{ id: 1, quantity_remaining: 10, unit_cost: '50000.00' }]);
    stockMutationsRepository.create.mockResolvedValue(1);
    costLayersRepository.consume.mockResolvedValue();
    costAllocationsRepository.create.mockResolvedValue();
    stocksRepository.decrement.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    const result = await service.completeOutbound(fakePool, 1, idempotencyOptions);

    expect(costLayersRepository.consume).toHaveBeenCalledTimes(1);
    expect(costLayersRepository.consume).toHaveBeenCalledWith(expect.anything(), 1, 4);
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'OUT', direction: 'OUT', quantity: 4, total_cost: '200000.00' })
    );
    expect(stocksRepository.decrement).toHaveBeenCalledWith(expect.anything(), 2, 1, 4);
    expect(result.statusCode).toBe(200);
  });

  it('completeOutbound splits a single mutation across multiple FIFO layers oldest-first', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 2, status: 'DRAFT' });
    repository.findDetails.mockResolvedValue([{ item_id: 1, quantity: 12 }]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 15 });
    costLayersRepository.lockAvailableLayers.mockResolvedValue([
      { id: 1, quantity_remaining: 10, unit_cost: '50000.00' },
      { id: 2, quantity_remaining: 5, unit_cost: '60000.00' }
    ]);
    stockMutationsRepository.create.mockResolvedValue(1);
    costLayersRepository.consume.mockResolvedValue();
    costAllocationsRepository.create.mockResolvedValue();
    stocksRepository.decrement.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await service.completeOutbound(fakePool, 1, idempotencyOptions);

    expect(costLayersRepository.consume).toHaveBeenCalledTimes(2);
    expect(costLayersRepository.consume).toHaveBeenNthCalledWith(1, expect.anything(), 1, 10);
    expect(costLayersRepository.consume).toHaveBeenNthCalledWith(2, expect.anything(), 2, 2);
    expect(costAllocationsRepository.create).toHaveBeenCalledTimes(2);
    expect(costAllocationsRepository.create).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ cost_layer_id: 1, quantity: 10, unit_cost: '50000.00' })
    );
    expect(costAllocationsRepository.create).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ cost_layer_id: 2, quantity: 2, unit_cost: '60000.00' })
    );
    // 10 * 50000 + 2 * 60000 = 620000, matching the mutation quantity exactly.
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity: 12, total_cost: '620000.00' })
    );
  });

  it('completeOutbound rejects when the stocks row does not have enough quantity', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 2, status: 'DRAFT' });
    repository.findDetails.mockResolvedValue([{ item_id: 1, quantity: 100 }]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 3 });

    await expect(service.completeOutbound(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK'
    });
    expect(costLayersRepository.lockAvailableLayers).not.toHaveBeenCalled();
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
  });

  it('completeOutbound rejects when the FIFO layers cannot cover the requested quantity', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 2, status: 'DRAFT' });
    repository.findDetails.mockResolvedValue([{ item_id: 1, quantity: 10 }]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 10 });
    costLayersRepository.lockAvailableLayers.mockResolvedValue([{ id: 1, quantity_remaining: 6, unit_cost: '50000.00' }]);

    await expect(service.completeOutbound(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK'
    });
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
  });

  it('completeOutbound rejects when the outbound is not DRAFT', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 2, status: 'COMPLETED' });

    await expect(service.completeOutbound(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
  });

  it('completeOutbound replays a previously committed response instead of posting again', async () => {
    idempotencyRepository.getOrCreate.mockImplementation(async (connection, { endpoint, requestHash }) => ({
      id: 1,
      endpoint,
      request_hash: requestHash,
      status: 'COMPLETED',
      response_code: 200,
      response_body: JSON.stringify({ data: { id: 1, status: 'COMPLETED' } })
    }));

    const result = await service.completeOutbound(fakePool, 1, idempotencyOptions);

    expect(repository.findByIdForUpdate).not.toHaveBeenCalled();
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusCode: 200, body: { data: { id: 1, status: 'COMPLETED' } } });
  });
});
