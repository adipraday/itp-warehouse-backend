import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/purchases/purchases.repository.js';
import * as inboundsRepository from '../../src/modules/inventory/inbounds/inbounds.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/purchases/purchases.service.js';

vi.mock('../../src/modules/purchases/purchases.repository.js');
vi.mock('../../src/modules/inventory/inbounds/inbounds.repository.js');
vi.mock('../../src/modules/inventory/stocks/stocks.repository.js');
vi.mock('../../src/modules/inventory/stock-mutations/stock-mutations.repository.js');
vi.mock('../../src/modules/inventory/costing/cost-layers.repository.js');
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

const idempotencyOptions = { idempotencyKey: 'key-1', endpoint: 'POST /api/purchases/1/complete', body: {}, ttlHours: 24 };

describe('purchases.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('completePurchase rejects when the purchase is not DRAFT', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, status: 'COMPLETED' });

    await expect(service.completePurchase(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
    expect(inboundsRepository.insertHeader).not.toHaveBeenCalled();
  });

  it('completePurchase links an INBOUND transaction, posts a mutation IN, and creates a FIFO layer once', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({
      id: 1,
      warehouse_id: 1,
      contact_id: 7,
      invoice_date: '2026-08-25',
      invoice_number: 'PUR-000001',
      status: 'DRAFT'
    });
    repository.findDetails.mockResolvedValue([{ id: 11, item_id: 1, quantity: 10, unit_price: '50000.00' }]);
    inboundsRepository.insertHeader.mockResolvedValue(70);
    inboundsRepository.insertDetails.mockResolvedValue();
    inboundsRepository.markCompleted.mockResolvedValue();
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 0 });
    stocksRepository.increment.mockResolvedValue();
    stockMutationsRepository.create.mockResolvedValue(300);
    costLayersRepository.create.mockResolvedValue(400);
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    const result = await service.completePurchase(fakePool, 1, idempotencyOptions);

    expect(inboundsRepository.insertHeader).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ warehouse_id: 1, contact_id: 7, transaction_date: '2026-08-25' }),
      null
    );
    expect(stockMutationsRepository.create).toHaveBeenCalledTimes(1);
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'IN',
        direction: 'IN',
        quantity: 10,
        total_cost: '500000.00',
        source_type: 'INVENTORY_TRANSACTION',
        source_id: 70,
        inventory_transaction_id: 70
      })
    );
    expect(costLayersRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity_received: 10, quantity_remaining: 10, unit_cost: '50000.00' })
    );
    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 1, 1, 10);
    expect(inboundsRepository.markCompleted).toHaveBeenCalledWith(expect.anything(), 70, null);
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 1, 70, null);
    expect(result.statusCode).toBe(200);
  });
});
