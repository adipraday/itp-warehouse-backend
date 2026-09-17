import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/returns/returns.repository.js';
import * as invoicesRepository from '../../src/modules/invoices/invoices.repository.js';
import * as inboundsRepository from '../../src/modules/inventory/inbounds/inbounds.repository.js';
import * as outboundsRepository from '../../src/modules/inventory/outbounds/outbounds.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../../src/modules/inventory/costing/cost-allocations.repository.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/returns/returns.service.js';

vi.mock('../../src/modules/returns/returns.repository.js');
vi.mock('../../src/modules/invoices/invoices.repository.js');
vi.mock('../../src/modules/inventory/inbounds/inbounds.repository.js');
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

const idempotencyOptions = { idempotencyKey: 'key-1', endpoint: 'POST /api/returns/1/complete', body: {}, ttlHours: 24 };

describe('returns.service validation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('createItemReturn rejects when both origin references are set', async () => {
    const payload = {
      warehouse_id: 1,
      contact_id: 1,
      type: 'RETURN_CUSTOMER',
      original_invoice_id: 5,
      original_inventory_transaction_id: 9,
      return_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 1, condition: 'GOOD', action: 'RESTOCK' }]
    };

    await expect(service.createItemReturn(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'EXACTLY_ONE_ORIGIN_REQUIRED'
    });
  });

  it('createItemReturn rejects a DAMAGED item that is not SCRAP', async () => {
    invoicesRepository.findById.mockResolvedValue({ id: 5, type: 'SALES', status: 'COMPLETED' });

    const payload = {
      warehouse_id: 1,
      contact_id: 1,
      type: 'RETURN_CUSTOMER',
      original_invoice_id: 5,
      return_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 1, condition: 'DAMAGED', action: 'RESTOCK' }]
    };

    await expect(service.createItemReturn(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'DAMAGED_MUST_BE_SCRAPPED'
    });
  });

  it('createItemReturn rejects REPLACE on a RETURN_SUPPLIER', async () => {
    inboundsRepository.findAnyById.mockResolvedValue({ id: 9, type: 'INBOUND', status: 'COMPLETED' });

    const payload = {
      warehouse_id: 1,
      contact_id: 1,
      type: 'RETURN_SUPPLIER',
      original_inventory_transaction_id: 9,
      return_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 1, condition: 'GOOD', action: 'REPLACE' }]
    };

    await expect(service.createItemReturn(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REPLACE_ACTION'
    });
  });

  it('createItemReturn rejects when the original invoice is not a COMPLETED SALES invoice', async () => {
    invoicesRepository.findById.mockResolvedValue({ id: 5, type: 'PURCHASE', status: 'COMPLETED' });

    const payload = {
      warehouse_id: 1,
      contact_id: 1,
      type: 'RETURN_CUSTOMER',
      original_invoice_id: 5,
      return_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 1, condition: 'GOOD', action: 'RESTOCK' }]
    };

    await expect(service.createItemReturn(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_ORIGIN_DOCUMENT'
    });
  });

  it('createItemReturn rejects an item that is not on the original document', async () => {
    invoicesRepository.findById.mockResolvedValue({ id: 5, type: 'SALES', status: 'COMPLETED' });
    repository.findInvoiceLine.mockResolvedValue(null);

    const payload = {
      warehouse_id: 1,
      contact_id: 1,
      type: 'RETURN_CUSTOMER',
      original_invoice_id: 5,
      return_date: '2026-08-25',
      details: [{ item_id: 99, quantity: 1, condition: 'GOOD', action: 'RESTOCK' }]
    };

    await expect(service.createItemReturn(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'ITEM_NOT_ON_ORIGINAL_DOCUMENT'
    });
  });

  it('createItemReturn rejects a quantity exceeding the remaining eligible quantity', async () => {
    invoicesRepository.findById.mockResolvedValue({ id: 5, type: 'SALES', status: 'COMPLETED' });
    repository.findInvoiceLine.mockResolvedValue({ quantity: 5, unit_cost: '30000.00' });
    repository.sumReturnedQuantityForInvoice.mockResolvedValue(3);

    const payload = {
      warehouse_id: 1,
      contact_id: 1,
      type: 'RETURN_CUSTOMER',
      original_invoice_id: 5,
      return_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 3, condition: 'GOOD', action: 'RESTOCK' }]
    };

    await expect(service.createItemReturn(fakePool, payload)).rejects.toMatchObject({
      statusCode: 409,
      code: 'RETURN_QUANTITY_EXCEEDS_ELIGIBLE'
    });
  });

  it('createItemReturn copies unit_cost from the original document, never from the client', async () => {
    invoicesRepository.findById.mockResolvedValue({ id: 5, type: 'SALES', status: 'COMPLETED' });
    repository.findInvoiceLine.mockResolvedValue({ quantity: 5, unit_cost: '30000.00' });
    repository.sumReturnedQuantityForInvoice.mockResolvedValue(0);
    repository.insertHeader.mockResolvedValue(1);
    repository.insertDetails.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1 });

    const payload = {
      warehouse_id: 1,
      contact_id: 1,
      type: 'RETURN_CUSTOMER',
      original_invoice_id: 5,
      return_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 2, condition: 'GOOD', action: 'RESTOCK' }]
    };

    await service.createItemReturn(fakePool, payload);

    expect(repository.insertDetails).toHaveBeenCalledWith(
      expect.anything(),
      1,
      [expect.objectContaining({ item_id: 1, quantity: 2, unit_cost: '30000.00' })]
    );
  });
});

describe('returns.service completion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('completeItemReturn skips DAMAGED lines entirely: no mutation, cost layer, or stock change', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({
      id: 1,
      type: 'RETURN_CUSTOMER',
      warehouse_id: 1,
      contact_id: 2,
      return_date: '2026-08-25',
      return_number: 'RET-000001',
      status: 'APPROVED'
    });
    repository.findDetails.mockResolvedValue([
      { id: 1, item_id: 1, quantity: 2, condition: 'DAMAGED', action: 'SCRAP', unit_cost: '30000.00', total_cost: '60000.00' }
    ]);
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await service.completeItemReturn(fakePool, 1, idempotencyOptions);

    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
    expect(costLayersRepository.create).not.toHaveBeenCalled();
    expect(stocksRepository.increment).not.toHaveBeenCalled();
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 1, null, null);
  });

  it('completeItemReturn restocks a GOOD+REPLACE line at historical cost and creates one replacement outbound', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({
      id: 1,
      type: 'RETURN_CUSTOMER',
      warehouse_id: 1,
      contact_id: 2,
      return_date: '2026-08-25',
      return_number: 'RET-000001',
      status: 'APPROVED'
    });
    repository.findDetails.mockResolvedValue([
      { id: 1, item_id: 1, quantity: 3, condition: 'GOOD', action: 'REPLACE', unit_cost: '30000.00', total_cost: '90000.00' }
    ]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 10 });
    stocksRepository.increment.mockResolvedValue();
    stocksRepository.decrement.mockResolvedValue();
    stockMutationsRepository.create.mockResolvedValueOnce(500).mockResolvedValueOnce(501);
    costLayersRepository.create.mockResolvedValue(600);
    costLayersRepository.lockAvailableLayers.mockResolvedValue([{ id: 9, quantity_remaining: 20, unit_cost: '25000.00' }]);
    costLayersRepository.consume.mockResolvedValue();
    costAllocationsRepository.create.mockResolvedValue();
    outboundsRepository.insertHeader.mockResolvedValue(70);
    outboundsRepository.insertDetails.mockResolvedValue();
    outboundsRepository.markCompleted.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await service.completeItemReturn(fakePool, 1, idempotencyOptions);

    // Restock-in step: return goods enter stock at the historical cost.
    expect(stockMutationsRepository.create).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ type: 'RETURN_IN', direction: 'IN', quantity: 3, total_cost: '90000.00' })
    );
    expect(costLayersRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity_received: 3, quantity_remaining: 3, unit_cost: '30000.00' })
    );
    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 1, 1, 3);

    // Replacement outbound created exactly once, at zero sale price, item/quantity unchanged.
    expect(outboundsRepository.insertHeader).toHaveBeenCalledTimes(1);
    expect(outboundsRepository.insertDetails).toHaveBeenCalledWith(
      expect.anything(),
      70,
      [{ item_id: 1, quantity: 3, unit_price: 0 }]
    );
    expect(stockMutationsRepository.create).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ type: 'OUT', direction: 'OUT', quantity: 3, source_id: 70 })
    );
    expect(outboundsRepository.markCompleted).toHaveBeenCalledWith(expect.anything(), 70, null);
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 1, 70, null);
  });

  it('completeItemReturn rolls back entirely when replacement stock is insufficient', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({
      id: 1,
      type: 'RETURN_CUSTOMER',
      warehouse_id: 1,
      contact_id: 2,
      return_date: '2026-08-25',
      return_number: 'RET-000001',
      status: 'APPROVED'
    });
    repository.findDetails.mockResolvedValue([
      { id: 1, item_id: 1, quantity: 3, condition: 'GOOD', action: 'REPLACE', unit_cost: '30000.00', total_cost: '90000.00' }
    ]);
    stocksRepository.ensureRow.mockResolvedValue();
    // First lockRow call is for the restock-in step (plenty of stock there);
    // second lockRow call is for the replacement outbound, which is short.
    stocksRepository.lockRow.mockResolvedValueOnce({ id: 1, quantity: 10 }).mockResolvedValueOnce({ id: 1, quantity: 1 });
    stocksRepository.increment.mockResolvedValue();
    stockMutationsRepository.create.mockResolvedValue(500);
    costLayersRepository.create.mockResolvedValue(600);
    outboundsRepository.insertHeader.mockResolvedValue(70);
    outboundsRepository.insertDetails.mockResolvedValue();

    await expect(service.completeItemReturn(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK'
    });
    expect(repository.markCompleted).not.toHaveBeenCalled();
  });

  it('completeItemReturn (RETURN_SUPPLIER) allocates FIFO and posts a RETURN_OUT mutation', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({
      id: 2,
      type: 'RETURN_SUPPLIER',
      warehouse_id: 1,
      contact_id: 3,
      return_date: '2026-08-25',
      return_number: 'RET-000002',
      status: 'APPROVED'
    });
    repository.findDetails.mockResolvedValue([
      { id: 2, item_id: 1, quantity: 4, condition: 'GOOD', action: 'RESTOCK', unit_cost: '20000.00', total_cost: '80000.00' }
    ]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 10 });
    stocksRepository.decrement.mockResolvedValue();
    costLayersRepository.lockAvailableLayers.mockResolvedValue([{ id: 4, quantity_remaining: 10, unit_cost: '20000.00' }]);
    stockMutationsRepository.create.mockResolvedValue(900);
    costLayersRepository.consume.mockResolvedValue();
    costAllocationsRepository.create.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 2, status: 'COMPLETED' });

    await service.completeItemReturn(fakePool, 2, idempotencyOptions);

    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'RETURN_OUT', direction: 'OUT', quantity: 4, total_cost: '80000.00' })
    );
    expect(stocksRepository.decrement).toHaveBeenCalledWith(expect.anything(), 1, 1, 4);
    expect(outboundsRepository.insertHeader).not.toHaveBeenCalled();
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 2, null, null);
  });

  it('completeItemReturn rejects when the return is not APPROVED', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, type: 'RETURN_CUSTOMER', status: 'DRAFT' });

    await expect(service.completeItemReturn(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
  });
});
