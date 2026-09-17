import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/inventory/inbounds/inbounds.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/inventory/inbounds/inbounds.service.js';

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
}

describe('inbounds.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('createInbound inserts the header and its details', async () => {
    repository.insertHeader.mockResolvedValue(1);
    repository.insertDetails.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, transaction_number: 'IN-000001' });

    const payload = { warehouse_id: 1, transaction_date: '2026-08-25', details: [{ item_id: 1, quantity: 10 }] };
    const result = await service.createInbound(fakePool, payload);

    expect(repository.insertHeader).toHaveBeenCalledWith(expect.anything(), payload, null);
    expect(repository.insertDetails).toHaveBeenCalledWith(expect.anything(), 1, payload.details);
    expect(result).toEqual({ data: { id: 1, transaction_number: 'IN-000001' } });
  });

  it('createInbound rejects a reversal without a reason', async () => {
    const payload = {
      warehouse_id: 1,
      transaction_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 10 }],
      reversal_of_transaction_id: 5
    };

    await expect(service.createInbound(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'REVERSAL_REASON_REQUIRED'
    });
    expect(repository.insertHeader).not.toHaveBeenCalled();
  });

  it('createInbound rejects a reversal target that is not COMPLETED', async () => {
    repository.findAnyById.mockResolvedValue({ id: 5, type: 'OUTBOUND', status: 'DRAFT' });

    const payload = {
      warehouse_id: 1,
      transaction_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 10 }],
      reversal_of_transaction_id: 5,
      reversal_reason: 'wrong quantity posted'
    };

    await expect(service.createInbound(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_REVERSAL_TARGET'
    });
  });

  it('updateInbound rejects when the inbound is not DRAFT', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await expect(
      service.updateInbound(fakePool, 1, { warehouse_id: 1, transaction_date: '2026-08-25', details: [] })
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS' });
  });

  it('deleteInbound rejects when the inbound is not DRAFT', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await expect(service.deleteInbound(fakePool, 1)).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS' });
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('cancelInbound cancels a DRAFT inbound', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT' });
    repository.markCancelled.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'CANCELLED' });

    const result = await service.cancelInbound(fakePool, 1);

    expect(repository.markCancelled).toHaveBeenCalledWith(fakePool, 1);
    expect(result).toEqual({ data: { id: 1, status: 'CANCELLED' } });
  });

  it('cancelInbound rejects when the inbound is not DRAFT', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await expect(service.cancelInbound(fakePool, 1)).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS' });
  });

  it('completeInbound posts one stock mutation, one cost layer, and increments stock exactly once', async () => {
    freshIdempotencyRecord();
    idempotencyRepository.markCompleted.mockResolvedValue();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 2, status: 'DRAFT' });
    repository.findDetails.mockResolvedValue([{ item_id: 1, quantity: 10, unit_price: '50000.00' }]);
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 0 });
    stockMutationsRepository.create.mockResolvedValue(1);
    costLayersRepository.create.mockResolvedValue(1);
    stocksRepository.increment.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    const result = await service.completeInbound(fakePool, 1, {
      idempotencyKey: 'key-1',
      endpoint: 'POST /api/inbounds/1/complete',
      body: {},
      ttlHours: 24
    });

    expect(stockMutationsRepository.create).toHaveBeenCalledTimes(1);
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'IN', direction: 'IN', quantity: 10, total_cost: '500000.00' })
    );
    expect(costLayersRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity_received: 10, quantity_remaining: 10, unit_cost: '50000.00' })
    );
    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 2, 1, 10);
    expect(idempotencyRepository.markCompleted).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ statusCode: 200, body: { data: { id: 1, status: 'COMPLETED' } } });
  });

  it('completeInbound rejects when the inbound is not DRAFT', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 2, status: 'COMPLETED' });

    await expect(
      service.completeInbound(fakePool, 1, { idempotencyKey: 'key-1', endpoint: 'POST /api/inbounds/1/complete', body: {}, ttlHours: 24 })
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS' });
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
  });

  it('completeInbound replays a previously committed response instead of posting again', async () => {
    idempotencyRepository.getOrCreate.mockResolvedValue({
      id: 1,
      endpoint: 'POST /api/inbounds/1/complete',
      request_hash: expect.any(String),
      status: 'COMPLETED',
      response_code: 200,
      response_body: JSON.stringify({ data: { id: 1, status: 'COMPLETED' } })
    });
    idempotencyRepository.getOrCreate.mockImplementation(async (connection, { endpoint, requestHash }) => ({
      id: 1,
      endpoint,
      request_hash: requestHash,
      status: 'COMPLETED',
      response_code: 200,
      response_body: JSON.stringify({ data: { id: 1, status: 'COMPLETED' } })
    }));

    const result = await service.completeInbound(fakePool, 1, {
      idempotencyKey: 'key-1',
      endpoint: 'POST /api/inbounds/1/complete',
      body: {},
      ttlHours: 24
    });

    expect(repository.findByIdForUpdate).not.toHaveBeenCalled();
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusCode: 200, body: { data: { id: 1, status: 'COMPLETED' } } });
  });

  it('completeInbound rejects with 409 IDEMPOTENCY_KEY_REUSED when the same key is replayed with a different body', async () => {
    idempotencyRepository.getOrCreate.mockResolvedValue({
      id: 1,
      endpoint: 'POST /api/inbounds/1/complete',
      request_hash: 'a-different-hash-from-a-prior-request',
      status: 'PROCESSING',
      response_code: null,
      response_body: null
    });

    await expect(
      service.completeInbound(fakePool, 1, {
        idempotencyKey: 'key-1',
        endpoint: 'POST /api/inbounds/1/complete',
        body: { extra: 'different body' },
        ttlHours: 24
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(repository.findByIdForUpdate).not.toHaveBeenCalled();
  });
});

// Regression coverage for the 2026-09-08 cross-tenant leak: an inbound must
// not be able to reference an item/contact outside the caller's business units.
describe('inbounds.service — item/contact bu_id scoping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function fakePoolWithItems(itemRows, contactRows = []) {
    return {
      execute: vi.fn(async (sql) => {
        if (sql.includes('FROM items')) return [itemRows];
        if (sql.includes('FROM contacts')) return [contactRows];
        throw new Error(`unexpected query: ${sql}`);
      })
    };
  }

  it('rejects a detail line whose item is outside the caller\'s business units', async () => {
    const pool = fakePoolWithItems([{ id: 1, bu_id: 99 }]);
    const payload = { warehouse_id: 1, transaction_date: '2026-08-25', details: [{ item_id: 1, quantity: 10 }] };

    await expect(service.createInbound(pool, payload, null, [11])).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
    expect(repository.insertHeader).not.toHaveBeenCalled();
  });

  it('rejects a header whose contact is outside the caller\'s business units', async () => {
    const pool = fakePoolWithItems([{ id: 1, bu_id: 11 }], [{ id: 5, bu_id: 99 }]);
    const payload = {
      warehouse_id: 1,
      contact_id: 5,
      transaction_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 10 }]
    };

    await expect(service.createInbound(pool, payload, null, [11])).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.insertHeader).not.toHaveBeenCalled();
  });

  it('passes when every referenced item/contact is in scope', async () => {
    const pool = fakePoolWithItems([{ id: 1, bu_id: 11 }], [{ id: 5, bu_id: 11 }]);
    repository.insertHeader.mockResolvedValue(1);
    repository.insertDetails.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1 });
    const payload = {
      warehouse_id: 1,
      contact_id: 5,
      transaction_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 10 }]
    };

    await expect(service.createInbound(pool, payload, null, [11])).resolves.toMatchObject({ data: { id: 1 } });
  });

  it('is unrestricted for super-admin (buIds null) — never even queries items/contacts', async () => {
    const pool = { execute: vi.fn() };
    repository.insertHeader.mockResolvedValue(1);
    repository.insertDetails.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1 });
    const payload = { warehouse_id: 1, transaction_date: '2026-08-25', details: [{ item_id: 1, quantity: 10 }] };

    await service.createInbound(pool, payload, null, null);

    expect(pool.execute).not.toHaveBeenCalled();
  });
});
