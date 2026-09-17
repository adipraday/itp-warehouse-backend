import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/sales/sales.repository.js';
import * as outboundsRepository from '../../src/modules/inventory/outbounds/outbounds.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as costAllocationsRepository from '../../src/modules/inventory/costing/cost-allocations.repository.js';
import * as warehousesRepository from '../../src/modules/warehouses/warehouses.repository.js';
import * as contactsRepository from '../../src/modules/contacts/contacts.repository.js';
import * as paymentsRepository from '../../src/modules/payments/payments.repository.js';
import * as businessUnitsClient from '../../src/shared/auth/business-units-client.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/sales/sales.service.js';

vi.mock('../../src/modules/sales/sales.repository.js');
vi.mock('../../src/modules/inventory/outbounds/outbounds.repository.js');
vi.mock('../../src/modules/inventory/stocks/stocks.repository.js');
vi.mock('../../src/modules/inventory/stock-mutations/stock-mutations.repository.js');
vi.mock('../../src/modules/inventory/costing/cost-layers.repository.js');
vi.mock('../../src/modules/inventory/costing/cost-allocations.repository.js');
vi.mock('../../src/modules/warehouses/warehouses.repository.js');
vi.mock('../../src/modules/contacts/contacts.repository.js');
vi.mock('../../src/modules/payments/payments.repository.js');
vi.mock('../../src/shared/auth/business-units-client.js');
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

const idempotencyOptions = { idempotencyKey: 'key-1', endpoint: 'POST /api/sales/1/complete', body: {}, ttlHours: 24 };

describe('sales.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('createSale rejects a reversal without a reason', async () => {
    const payload = {
      warehouse_id: 1,
      invoice_date: '2026-08-25',
      details: [{ item_id: 1, quantity: 2, unit_price: 100000 }],
      reversal_of_invoice_id: 5
    };

    await expect(service.createSale(fakePool, payload)).rejects.toMatchObject({
      statusCode: 400,
      code: 'REVERSAL_REASON_REQUIRED'
    });
    expect(repository.insertHeader).not.toHaveBeenCalled();
  });

  it('createSale computes and stores totals from the line items', async () => {
    repository.insertHeader.mockResolvedValue(1);
    repository.insertDetails.mockResolvedValue();
    repository.computeAndStoreTotals.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, invoice_number: 'SAL-000001' });

    const payload = {
      warehouse_id: 1,
      invoice_date: '2026-08-25',
      tax_rate: 0.1,
      details: [{ item_id: 1, quantity: 2, unit_price: 100000 }]
    };
    await service.createSale(fakePool, payload);

    expect(repository.computeAndStoreTotals).toHaveBeenCalledWith(expect.anything(), 1, 0.1, 0);
  });

  describe('discount_amount (2026-09-13)', () => {
    it('passes discount_amount through to computeAndStoreTotals', async () => {
      repository.insertHeader.mockResolvedValue(1);
      repository.insertDetails.mockResolvedValue();
      repository.computeAndStoreTotals.mockResolvedValue();
      repository.findByIdWithDetails.mockResolvedValue({ id: 1 });

      const payload = {
        warehouse_id: 1,
        invoice_date: '2026-08-25',
        tax_rate: 0,
        discount_amount: 50000,
        details: [{ item_id: 1, quantity: 2, unit_price: 100000 }]
      };
      await service.createSale(fakePool, payload);

      expect(repository.computeAndStoreTotals).toHaveBeenCalledWith(expect.anything(), 1, 0, 50000);
    });

    it('rejects a discount_amount larger than the subtotal derived from details', async () => {
      const payload = {
        warehouse_id: 1,
        invoice_date: '2026-08-25',
        discount_amount: 999999,
        details: [{ item_id: 1, quantity: 2, unit_price: 100000 }] // subtotal = 200000
      };

      await expect(service.createSale(fakePool, payload)).rejects.toMatchObject({
        statusCode: 400,
        code: 'DISCOUNT_EXCEEDS_SUBTOTAL'
      });
      expect(repository.insertHeader).not.toHaveBeenCalled();
    });

    it('updateSale also rejects an excessive discount before touching the DB', async () => {
      repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT' });

      const payload = {
        warehouse_id: 1,
        invoice_date: '2026-08-25',
        discount_amount: 999999,
        details: [{ item_id: 1, quantity: 1, unit_price: 100000 }]
      };

      await expect(service.updateSale(fakePool, 1, payload)).rejects.toMatchObject({
        statusCode: 400,
        code: 'DISCOUNT_EXCEEDS_SUBTOTAL'
      });
      expect(repository.updateHeader).not.toHaveBeenCalled();
    });

    it('allows a discount exactly equal to the subtotal (100% off)', async () => {
      repository.insertHeader.mockResolvedValue(1);
      repository.insertDetails.mockResolvedValue();
      repository.computeAndStoreTotals.mockResolvedValue();
      repository.findByIdWithDetails.mockResolvedValue({ id: 1 });

      const payload = {
        warehouse_id: 1,
        invoice_date: '2026-08-25',
        discount_amount: 200000,
        details: [{ item_id: 1, quantity: 2, unit_price: 100000 }]
      };

      await expect(service.createSale(fakePool, payload)).resolves.toBeDefined();
    });
  });

  it('completeSale rejects when the sale is not DRAFT', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, status: 'COMPLETED' });

    await expect(service.completeSale(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
    expect(outboundsRepository.insertHeader).not.toHaveBeenCalled();
  });

  it('completeSale rejects when stock is insufficient', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({ id: 1, warehouse_id: 1, contact_id: null, invoice_date: '2026-08-25', invoice_number: 'SAL-000001', status: 'DRAFT' });
    repository.findDetails.mockResolvedValue([{ id: 1, item_id: 1, quantity: 100, unit_price: '100000.00' }]);
    outboundsRepository.insertHeader.mockResolvedValue(50);
    outboundsRepository.insertDetails.mockResolvedValue();
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 3 });

    await expect(service.completeSale(fakePool, 1, idempotencyOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK'
    });
    expect(stockMutationsRepository.create).not.toHaveBeenCalled();
  });

  it('completeSale links an OUTBOUND transaction, posts FIFO, and freezes HPP on the invoice detail', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue({
      id: 1,
      warehouse_id: 1,
      contact_id: 9,
      invoice_date: '2026-08-25',
      invoice_number: 'SAL-000001',
      status: 'DRAFT'
    });
    repository.findDetails.mockResolvedValue([{ id: 11, item_id: 1, quantity: 4, unit_price: '150000.00' }]);
    outboundsRepository.insertHeader.mockResolvedValue(50);
    outboundsRepository.insertDetails.mockResolvedValue();
    outboundsRepository.markCompleted.mockResolvedValue();
    stocksRepository.ensureRow.mockResolvedValue();
    stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 10 });
    stocksRepository.decrement.mockResolvedValue();
    costLayersRepository.lockAvailableLayers.mockResolvedValue([{ id: 3, quantity_remaining: 10, unit_cost: '80000.00' }]);
    stockMutationsRepository.create.mockResolvedValue(200);
    costLayersRepository.consume.mockResolvedValue();
    costAllocationsRepository.create.mockResolvedValue();
    repository.setDetailCost.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    const result = await service.completeSale(fakePool, 1, idempotencyOptions);

    expect(outboundsRepository.insertHeader).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ warehouse_id: 1, contact_id: 9, transaction_date: '2026-08-25' }),
      null
    );
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source_type: 'INVENTORY_TRANSACTION', source_id: 50, inventory_transaction_id: 50, quantity: 4 })
    );
    // 4 units * 80000 cost = 320000 total; unit_cost = 320000 / 4 = 80000.00
    expect(repository.setDetailCost).toHaveBeenCalledWith(expect.anything(), 11, {
      unit_cost: '80000.00',
      cost_amount: '320000.00'
    });
    expect(outboundsRepository.markCompleted).toHaveBeenCalledWith(expect.anything(), 50, null);
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 1, 50, null);
    expect(result.statusCode).toBe(200);
  });

  describe('holdSale / resumeSale (2026-09-13)', () => {
    it('holdSale throws 404 when the sale does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.holdSale(fakePool, 999)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('holdSale throws 409 INVALID_STATUS for a non-DRAFT sale', async () => {
      repository.findById.mockResolvedValue({ id: 1, status: 'COMPLETED' });

      await expect(service.holdSale(fakePool, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVALID_STATUS'
      });
      expect(repository.markHeld).not.toHaveBeenCalled();
    });

    it('holdSale marks a DRAFT sale held with the given label', async () => {
      repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT' });
      repository.findByIdWithDetails.mockResolvedValue({ id: 1, held_at: '2026-09-13 10:00:00', hold_label: 'Meja 5' });

      const result = await service.holdSale(fakePool, 1, 'Meja 5');

      expect(repository.markHeld).toHaveBeenCalledWith(fakePool, 1, 'Meja 5');
      expect(result.data.hold_label).toBe('Meja 5');
    });

    it('holdSale allows re-holding an already-held DRAFT (refreshes it, no error)', async () => {
      repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT', held_at: '2026-09-13 09:00:00' });
      repository.findByIdWithDetails.mockResolvedValue({ id: 1 });

      await expect(service.holdSale(fakePool, 1, 'Updated label')).resolves.toBeDefined();
      expect(repository.markHeld).toHaveBeenCalledWith(fakePool, 1, 'Updated label');
    });

    it('resumeSale throws 404 when the sale does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.resumeSale(fakePool, 999)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('resumeSale throws 409 NOT_HELD when the sale is not currently held', async () => {
      repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT', held_at: null });

      await expect(service.resumeSale(fakePool, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: 'NOT_HELD'
      });
      expect(repository.markResumed).not.toHaveBeenCalled();
    });

    it('resumeSale clears the hold on a currently-held sale', async () => {
      repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT', held_at: '2026-09-13 09:00:00' });
      repository.findByIdWithDetails.mockResolvedValue({ id: 1, held_at: null });

      const result = await service.resumeSale(fakePool, 1);

      expect(repository.markResumed).toHaveBeenCalledWith(fakePool, 1);
      expect(result.data.held_at).toBeNull();
    });
  });

  describe('getSaleReceipt', () => {
    it('throws 404 when the sale does not exist', async () => {
      repository.findByIdWithDetails.mockResolvedValue(null);

      await expect(service.getSaleReceipt(fakePool, 999)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 409 INVALID_STATUS for a sale that is not COMPLETED', async () => {
      repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'DRAFT' });

      await expect(service.getSaleReceipt(fakePool, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVALID_STATUS'
      });
    });

    it('gathers warehouse/business-unit/customer/payments and builds the receipt', async () => {
      repository.findByIdWithDetails.mockResolvedValue({
        id: 1,
        status: 'COMPLETED',
        warehouse_id: 1,
        contact_id: 9,
        invoice_number: 'SAL-000001',
        invoice_date: '2026-09-13',
        subtotal: '300000.00',
        tax: '0.00',
        total_amount: '300000.00',
        details: [{ sku: 'SKU-1', name: 'Router', quantity: 2, unit_price: '150000.00', amount: '300000.00' }]
      });
      warehousesRepository.findById.mockResolvedValue({ id: 1, code: 'WH-1', name: 'Gudang Pusat', address: null, bu_id: 13 });
      contactsRepository.findById.mockResolvedValue({ id: 9, name: 'Budi Santoso' });
      paymentsRepository.findByInvoiceId.mockResolvedValue([
        { payment_method: 'CASH', amount: '300000.00', payment_date: '2026-09-13' }
      ]);
      businessUnitsClient.getBusinessUnitById.mockResolvedValue({ id: 13, name: 'PT Cakrawala Abadi' });

      const fakeConfig = {};
      const result = await service.getSaleReceipt(fakePool, 1, fakeConfig);

      expect(warehousesRepository.findById).toHaveBeenCalledWith(fakePool, 1);
      expect(contactsRepository.findById).toHaveBeenCalledWith(fakePool, 9);
      expect(businessUnitsClient.getBusinessUnitById).toHaveBeenCalledWith(fakeConfig, 13);
      expect(result.data.business_unit).toEqual({ id: 13, name: 'PT Cakrawala Abadi' });
      expect(result.data.customer).toEqual({ id: 9, name: 'Budi Santoso' });
      expect(result.data.amount_paid).toBe('300000.00');
      expect(result.data.balance_due).toBe('0.00');
      expect(typeof result.data.escpos_base64).toBe('string');
    });

    it('skips the business-unit lookup when no config is given (e.g. unit tests / no auth-backend)', async () => {
      repository.findByIdWithDetails.mockResolvedValue({
        id: 1,
        status: 'COMPLETED',
        warehouse_id: 1,
        contact_id: null,
        invoice_number: 'SAL-000001',
        invoice_date: '2026-09-13',
        subtotal: '0.00',
        tax: '0.00',
        total_amount: '0.00',
        details: []
      });
      warehousesRepository.findById.mockResolvedValue({ id: 1, code: 'WH-1', name: 'Gudang Pusat', address: null, bu_id: 13 });
      paymentsRepository.findByInvoiceId.mockResolvedValue([]);

      const result = await service.getSaleReceipt(fakePool, 1, null);

      expect(businessUnitsClient.getBusinessUnitById).not.toHaveBeenCalled();
      expect(contactsRepository.findById).not.toHaveBeenCalled();
      expect(result.data.business_unit).toBeNull();
      expect(result.data.customer).toBeNull();
    });
  });
});
