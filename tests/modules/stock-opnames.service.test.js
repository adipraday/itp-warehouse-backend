import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/stock-opnames/stock-opnames.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../../src/modules/inventory/costing/cost-allocations.repository.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/stock-opnames/stock-opnames.service.js';

vi.mock('../../src/modules/stock-opnames/stock-opnames.repository.js');
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

const idempotencyOptions = { idempotencyKey: 'key-1', endpoint: 'POST /api/stock-opnames/1/approve', body: {}, ttlHours: 24 };

describe('stock-opnames.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('submitStockOpname rejects when the opname is not DRAFT', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'SUBMITTED' });

    await expect(service.submitStockOpname(fakePool, 1)).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS' });
  });

  it('cancelStockOpname allows cancellation from SUBMITTED', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'SUBMITTED' });
    repository.markCancelled.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'CANCELLED' });

    const result = await service.cancelStockOpname(fakePool, 1);

    expect(result).toEqual({ data: { id: 1, status: 'CANCELLED' } });
  });

  it('approveStockOpname rejects when the opname is not SUBMITTED', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, status: 'DRAFT' });

    await expect(service.approveStockOpname(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
  });

  it('approveStockOpname posts an ADJUSTMENT IN with unit_cost 0 for a positive difference', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, status: 'SUBMITTED' });
    repository.findDetails.mockResolvedValue([
      { item_id: 1, system_qty: 10, physical_qty: 13, difference: 3 }
    ]);
    stocksRepository.ensureRow.mockResolvedValue();
    stockMutationsRepository.create.mockResolvedValue(1);
    costLayersRepository.create.mockResolvedValue(1);
    stocksRepository.increment.mockResolvedValue();
    repository.markApproved.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'APPROVED' });

    await service.approveStockOpname(fakePool, 1, idempotencyOptions);

    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'ADJUSTMENT', direction: 'IN', quantity: 3, total_cost: '0.00' })
    );
    expect(costLayersRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity_received: 3, quantity_remaining: 3, unit_cost: 0 })
    );
    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 1, 1, 3);
    expect(stocksRepository.decrement).not.toHaveBeenCalled();
  });

  it('approveStockOpname posts an ADJUSTMENT OUT through FIFO allocation for a negative difference', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, status: 'SUBMITTED' });
    repository.findDetails.mockResolvedValue([
      { item_id: 1, system_qty: 10, physical_qty: 7, difference: -3 }
    ]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 10 });
    costLayersRepository.lockAvailableLayers.mockResolvedValue([{ id: 5, quantity_remaining: 10, unit_cost: '40000.00' }]);
    stockMutationsRepository.create.mockResolvedValue(9);
    costLayersRepository.consume.mockResolvedValue();
    costAllocationsRepository.create.mockResolvedValue();
    stocksRepository.decrement.mockResolvedValue();
    repository.markApproved.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'APPROVED' });

    await service.approveStockOpname(fakePool, 1, idempotencyOptions);

    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'ADJUSTMENT', direction: 'OUT', quantity: 3, total_cost: '120000.00' })
    );
    expect(costLayersRepository.consume).toHaveBeenCalledWith(expect.anything(), 5, 3);
    expect(stocksRepository.decrement).toHaveBeenCalledWith(expect.anything(), 1, 1, 3);
    expect(costLayersRepository.create).not.toHaveBeenCalled();
  });

  it('approveStockOpname skips items with no difference', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, status: 'SUBMITTED' });
    repository.findDetails.mockResolvedValue([
      { item_id: 1, system_qty: 10, physical_qty: 10, difference: 0 }
    ]);
    repository.markApproved.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'APPROVED' });

    await service.approveStockOpname(fakePool, 1, idempotencyOptions);

    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
    expect(stocksRepository.ensureRow).not.toHaveBeenCalled();
  });

  it('approveStockOpname rejects a shortage larger than the current stock', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, status: 'SUBMITTED' });
    repository.findDetails.mockResolvedValue([
      { item_id: 1, system_qty: 10, physical_qty: 2, difference: -8 }
    ]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 5 });

    await expect(service.approveStockOpname(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK'
    });
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
  });
});
