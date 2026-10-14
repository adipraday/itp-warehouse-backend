import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/purchases/purchases.repository.js';
import * as invoicesRepository from '../../src/modules/invoices/invoices.repository.js';
import * as inboundsRepository from '../../src/modules/inventory/inbounds/inbounds.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import * as warehousesRepository from '../../src/modules/warehouses/warehouses.repository.js';
import * as idempotencyRepository from '../../src/shared/idempotency/idempotency.repository.js';
import * as service from '../../src/modules/purchases/purchases.service.js';

vi.mock('../../src/modules/purchases/purchases.repository.js');
vi.mock('../../src/modules/invoices/invoices.repository.js');
vi.mock('../../src/modules/inventory/inbounds/inbounds.repository.js');
vi.mock('../../src/modules/inventory/stocks/stocks.repository.js');
vi.mock('../../src/modules/inventory/stock-mutations/stock-mutations.repository.js');
vi.mock('../../src/modules/inventory/costing/cost-layers.repository.js');
vi.mock('../../src/modules/warehouses/warehouses.repository.js');
vi.mock('../../src/shared/idempotency/idempotency.repository.js');
vi.mock('../../src/shared/notifications/push.js', () => ({ notifyStakeholders: vi.fn().mockResolvedValue() }));
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

const baseOptions = { idempotencyKey: 'key-1', endpoint: 'POST /api/purchases/1/receive', body: {}, ttlHours: 24 };

function submittedPurchase(overrides = {}) {
  return {
    id: 1,
    warehouse_id: 1,
    contact_id: 7,
    invoice_date: '2026-08-25',
    invoice_number: 'PUR-000001',
    status: 'DRAFT',
    receipt_status: 'PENDING_APPROVAL',
    tax_rate: '0.000000',
    created_by: 5,
    ...overrides
  };
}

function detail(overrides = {}) {
  return { id: 11, item_id: 1, quantity: 10, received_quantity: 0, closed_quantity: 0, unit_price: '50000.00', ...overrides };
}

function mockStockPosting() {
  inboundsRepository.insertHeader.mockResolvedValue(70);
  inboundsRepository.insertDetails.mockResolvedValue();
  inboundsRepository.markCompleted.mockResolvedValue();
  stocksRepository.ensureRow.mockResolvedValue();
  stocksRepository.lockRow.mockResolvedValue({ id: 1, quantity: 0 });
  stocksRepository.increment.mockResolvedValue();
  stockMutationsRepository.create.mockResolvedValue(300);
  costLayersRepository.create.mockResolvedValue(400);
  repository.insertReceipt.mockResolvedValue(900);
  repository.addReceivedQuantity.mockResolvedValue();
  repository.markCompleted.mockResolvedValue();
  repository.markPartiallyReceived.mockResolvedValue();
  repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });
}

describe('purchases.service — receive (warehouse approval)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    warehousesRepository.findById.mockResolvedValue({ id: 1, bu_id: 1 });
  });

  it('rejects when the purchase is not a DRAFT', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ status: 'COMPLETED', receipt_status: null }));

    await expect(service.receivePurchase(fakePool, 1, baseOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATUS'
    });
    expect(inboundsRepository.insertHeader).not.toHaveBeenCalled();
  });

  it('refuses to put goods in stock before the purchase is submitted for approval', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ receipt_status: null }));

    await expect(service.receivePurchase(fakePool, 1, baseOptions)).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPROVAL_REQUIRED'
    });
    expect(inboundsRepository.insertHeader).not.toHaveBeenCalled();
    expect(stocksRepository.increment).not.toHaveBeenCalled();
  });

  it('receives everything outstanding: INBOUND transaction, mutation IN, FIFO layer, receipt row, COMPLETED', async () => {
    freshIdempotencyRecord();
    mockStockPosting();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());
    repository.findDetailsForUpdate.mockResolvedValue([detail()]);

    const result = await service.receivePurchase(fakePool, 1, baseOptions);

    expect(inboundsRepository.insertHeader).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ warehouse_id: 1, contact_id: 7, transaction_date: '2026-08-25' }),
      null
    );
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'IN', direction: 'IN', quantity: 10, total_cost: '500000.00', source_id: 70 })
    );
    expect(costLayersRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity_received: 10, quantity_remaining: 10, unit_cost: '50000.00' })
    );
    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 1, 1, 10);
    expect(repository.addReceivedQuantity).toHaveBeenCalledWith(expect.anything(), 11, 10);
    expect(repository.insertReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 1, inventoryTransactionId: 70 })
    );
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 1, 70, null);
    expect(repository.markPartiallyReceived).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(200);
  });

  it('a partial receipt with WAIT stocks only the received quantity and keeps the purchase open', async () => {
    freshIdempotencyRecord();
    mockStockPosting();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());
    repository.findDetailsForUpdate.mockResolvedValue([detail()]);

    await service.receivePurchase(fakePool, 1, {
      ...baseOptions,
      lines: [{ item_id: 1, quantity: 6 }],
      shortfallAction: 'WAIT'
    });

    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 1, 1, 6);
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity: 6, total_cost: '300000.00' })
    );
    expect(repository.markPartiallyReceived).toHaveBeenCalledWith(expect.anything(), 1, 70);
    expect(repository.markCompleted).not.toHaveBeenCalled();
    expect(repository.addClosedQuantity).not.toHaveBeenCalled();
  });

  it('a partial receipt with REFUND closes the shortfall, re-prices the purchase and completes it', async () => {
    freshIdempotencyRecord();
    mockStockPosting();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());
    repository.findDetailsForUpdate.mockResolvedValue([detail()]);
    repository.addClosedQuantity.mockResolvedValue();
    repository.computeAndStoreTotals.mockResolvedValue(300000);
    repository.sumPaid.mockResolvedValue(500000);
    repository.setCancelReason.mockResolvedValue();
    invoicesRepository.updatePaymentStatus.mockResolvedValue();

    await service.receivePurchase(fakePool, 1, {
      ...baseOptions,
      lines: [{ item_id: 1, quantity: 6 }],
      shortfallAction: 'REFUND',
      notes: 'Supplier kirim 6 dari 10'
    });

    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 1, 1, 6);
    expect(repository.addClosedQuantity).toHaveBeenCalledWith(expect.anything(), 11, 4);
    expect(repository.computeAndStoreTotals).toHaveBeenCalledWith(expect.anything(), 1, 0);
    expect(invoicesRepository.updatePaymentStatus).toHaveBeenCalledWith(expect.anything(), 1, 'PAID');
    expect(repository.setCancelReason).toHaveBeenCalledWith(expect.anything(), 1, 'Supplier kirim 6 dari 10');
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 1, 70, null);
  });

  it('a later receipt of the awaited remainder completes the purchase', async () => {
    freshIdempotencyRecord();
    mockStockPosting();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ receipt_status: 'PARTIALLY_RECEIVED' }));
    repository.findDetailsForUpdate.mockResolvedValue([detail({ received_quantity: 6 })]);

    await service.receivePurchase(fakePool, 1, { ...baseOptions, lines: [{ item_id: 1, quantity: 4 }] });

    expect(stocksRepository.increment).toHaveBeenCalledWith(expect.anything(), 1, 1, 4);
    expect(repository.markCompleted).toHaveBeenCalled();
  });

  it('requires a shortfall action when something is still missing', async () => {
    freshIdempotencyRecord();
    mockStockPosting();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());
    repository.findDetailsForUpdate.mockResolvedValue([detail()]);

    await expect(
      service.receivePurchase(fakePool, 1, { ...baseOptions, lines: [{ item_id: 1, quantity: 6 }] })
    ).rejects.toMatchObject({ statusCode: 400, code: 'SHORTFALL_ACTION_REQUIRED' });
    expect(stocksRepository.increment).not.toHaveBeenCalled();
  });

  it('rejects a received quantity above what is outstanding', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());
    repository.findDetailsForUpdate.mockResolvedValue([detail({ received_quantity: 6 })]);

    await expect(
      service.receivePurchase(fakePool, 1, { ...baseOptions, lines: [{ item_id: 1, quantity: 5 }] })
    ).rejects.toMatchObject({ statusCode: 409, code: 'RECEIVED_QUANTITY_EXCEEDS_ORDERED' });
  });

  it('rejects an item that is not on the purchase and a receipt of nothing', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());
    repository.findDetailsForUpdate.mockResolvedValue([detail()]);

    await expect(
      service.receivePurchase(fakePool, 1, { ...baseOptions, lines: [{ item_id: 99, quantity: 1 }] })
    ).rejects.toMatchObject({ code: 'ITEM_NOT_ON_PURCHASE' });
    await expect(
      service.receivePurchase(fakePool, 1, { ...baseOptions, lines: [{ item_id: 1, quantity: 0 }], shortfallAction: 'WAIT' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'NOTHING_RECEIVED' });
  });

  it('an admin-warehouse cannot approve a purchase they created, or one at a warehouse they are not assigned to', async () => {
    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ created_by: 5 }));

    await expect(
      service.receivePurchase(fakePool, 1, {
        ...baseOptions,
        context: { role: 'admin-warehouse', userId: 5, assignedWarehouseIds: [1] }
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.receivePurchase(fakePool, 1, {
        ...baseOptions,
        context: { role: 'admin-warehouse', userId: 9, assignedWarehouseIds: [2] }
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(inboundsRepository.insertHeader).not.toHaveBeenCalled();
  });

  it('an assigned admin-warehouse who did not create the purchase may approve it; admin-bu is unrestricted', async () => {
    mockStockPosting();
    // Fresh rows per call, as the database would return (the service updates them in place).
    repository.findDetailsForUpdate.mockImplementation(async () => [detail()]);

    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ created_by: 5 }));
    const byWarehouseAdmin = await service.receivePurchase(fakePool, 1, {
      ...baseOptions,
      context: { role: 'admin-warehouse', userId: 9, assignedWarehouseIds: [1] }
    });
    expect(byWarehouseAdmin.statusCode).toBe(200);

    freshIdempotencyRecord();
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ created_by: 9 }));
    const byAdminBu = await service.receivePurchase(fakePool, 1, {
      ...baseOptions,
      context: { role: 'admin-bu', userId: 9, assignedWarehouseIds: null }
    });
    expect(byAdminBu.statusCode).toBe(200);
  });
});

describe('purchases.service — submit, edit lock, cancel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    warehousesRepository.findById.mockResolvedValue({ id: 1, bu_id: 1 });
  });

  it('submit requires the purchase to be fully paid', async () => {
    repository.findByIdForUpdate.mockResolvedValue(
      submittedPurchase({ receipt_status: null, total_amount: '500000.00', payment_status: 'PARTIAL' })
    );

    await expect(service.submitPurchase(fakePool, 1, 5)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_REQUIRED'
    });
    expect(repository.markSubmitted).not.toHaveBeenCalled();
  });

  it('submit marks a paid purchase as awaiting approval, and only once', async () => {
    repository.findByIdForUpdate.mockResolvedValue(
      submittedPurchase({ receipt_status: null, total_amount: '500000.00', payment_status: 'PAID' })
    );
    repository.markSubmitted.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, receipt_status: 'PENDING_APPROVAL' });

    const result = await service.submitPurchase(fakePool, 1, 5);
    expect(repository.markSubmitted).toHaveBeenCalledWith(expect.anything(), 1, 5);
    expect(result.data.receipt_status).toBe('PENDING_APPROVAL');

    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ total_amount: '500000.00', payment_status: 'PAID' }));
    await expect(service.submitPurchase(fakePool, 1, 5)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('a purchase with a payment, or one already submitted, can no longer be edited or deleted', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT', receipt_status: null, paid_amount: '100.00' });
    await expect(service.deletePurchase(fakePool, 1)).rejects.toMatchObject({ statusCode: 409, code: 'PURCHASE_LOCKED' });

    repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT', receipt_status: 'PENDING_APPROVAL', paid_amount: '0.00' });
    await expect(
      service.updatePurchase(fakePool, 1, { warehouse_id: 1, invoice_date: '2026-08-25', details: [{ item_id: 1, quantity: 1 }] })
    ).rejects.toMatchObject({ code: 'PURCHASE_LOCKED' });
  });

  it('cancelling an unpaid, unsubmitted draft works as before and needs no reason', async () => {
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ receipt_status: null }));
    repository.sumPaid.mockResolvedValue(0);
    repository.markCancelled.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'CANCELLED' });

    await service.cancelPurchase(fakePool, 1, {}, 5);

    expect(repository.markCancelled).toHaveBeenCalledWith(expect.anything(), 1, null);
    expect(repository.addClosedQuantity).not.toHaveBeenCalled();
  });

  it('cancelling a paid purchase needs a reason, then closes every line so the whole payment is refund due', async () => {
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());
    repository.sumPaid.mockResolvedValue(500000);

    await expect(service.cancelPurchase(fakePool, 1, {}, 5)).rejects.toMatchObject({
      statusCode: 400,
      code: 'CANCEL_REASON_REQUIRED'
    });

    repository.findDetailsForUpdate.mockResolvedValue([detail()]);
    repository.addClosedQuantity.mockResolvedValue();
    repository.computeAndStoreTotals.mockResolvedValue(0);
    repository.markCancelled.mockResolvedValue();
    invoicesRepository.updatePaymentStatus.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'CANCELLED' });

    await service.cancelPurchase(fakePool, 1, { reason: 'Supplier tidak bisa kirim' }, 5);

    expect(repository.addClosedQuantity).toHaveBeenCalledWith(expect.anything(), 11, 10);
    expect(repository.markCancelled).toHaveBeenCalledWith(expect.anything(), 1, 'Supplier tidak bisa kirim');
    expect(repository.markCompleted).not.toHaveBeenCalled();
  });

  it('cancelling after a partial receipt closes only the remainder and ends the purchase COMPLETED', async () => {
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ receipt_status: 'PARTIALLY_RECEIVED' }));
    repository.sumPaid.mockResolvedValue(500000);
    repository.findDetailsForUpdate.mockResolvedValue([detail({ received_quantity: 6 })]);
    repository.addClosedQuantity.mockResolvedValue();
    repository.computeAndStoreTotals.mockResolvedValue(300000);
    repository.setCancelReason.mockResolvedValue();
    repository.markCompleted.mockResolvedValue();
    invoicesRepository.updatePaymentStatus.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1, status: 'COMPLETED' });

    await service.cancelPurchase(fakePool, 1, { reason: 'Sisa barang batal' }, 5);

    expect(repository.addClosedQuantity).toHaveBeenCalledWith(expect.anything(), 11, 4);
    expect(repository.markCompleted).toHaveBeenCalledWith(expect.anything(), 1, null, 5);
    expect(repository.markCancelled).not.toHaveBeenCalled();
  });
});

describe('purchases.service — refunds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const payload = { amount: 200000, refund_method: 'TRANSFER', refund_date: '2026-10-14' };

  it('only a completed or cancelled purchase can be refunded', async () => {
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase());

    await expect(service.recordRefund(fakePool, 1, payload, 3)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('refuses a refund above what is due (paid minus final total minus refunds already recorded)', async () => {
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ status: 'COMPLETED', receipt_status: null, total_amount: '300000.00' }));
    repository.sumPaid.mockResolvedValue(500000);
    repository.sumRefunded.mockResolvedValue(50000);

    await expect(service.recordRefund(fakePool, 1, payload, 3)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AMOUNT_EXCEEDS_REFUND_DUE'
    });
    expect(repository.insertRefund).not.toHaveBeenCalled();
  });

  it('records a refund within the amount due', async () => {
    repository.findByIdForUpdate.mockResolvedValue(submittedPurchase({ status: 'COMPLETED', receipt_status: null, total_amount: '300000.00' }));
    repository.sumPaid.mockResolvedValue(500000);
    repository.sumRefunded.mockResolvedValue(0);
    repository.insertRefund.mockResolvedValue(8);
    repository.findRefundById.mockResolvedValue({ id: 8, refund_number: 'REF-000008' });
    repository.findByIdWithDetails.mockResolvedValue({ id: 1 });

    const result = await service.recordRefund(fakePool, 1, payload, 3);

    expect(repository.insertRefund).toHaveBeenCalledWith(
      expect.anything(),
      { invoiceId: 1, amount: 200000, refundMethod: 'TRANSFER', refundDate: '2026-10-14', notes: null },
      3
    );
    expect(result.data.refund_number).toBe('REF-000008');
  });
});

describe('purchases.service — supplier invoice file', () => {
  const pdf = (overrides = {}) => ({
    buffer: Buffer.from('%PDF-1.7 fake'),
    filename: 'inv-123.pdf',
    mimetype: 'application/pdf',
    ...overrides
  });

  function fakeStorage() {
    return { putObject: vi.fn().mockResolvedValue(), getObject: vi.fn(), deleteObject: vi.fn().mockResolvedValue() };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    repository.findById.mockResolvedValue({ id: 1, status: 'DRAFT' });
    repository.findSupplierInvoiceFile.mockResolvedValue(null);
    repository.setSupplierInvoiceFile.mockResolvedValue();
    repository.findByIdWithDetails.mockResolvedValue({ id: 1 });
  });

  it('answers 503 when storage is not configured', async () => {
    await expect(service.uploadSupplierInvoiceFile(fakePool, null, 1, pdf())).rejects.toMatchObject({
      statusCode: 503,
      code: 'STORAGE_NOT_CONFIGURED'
    });
  });

  it('accepts only real PDFs: wrong type, wrong magic bytes, empty and oversized are rejected', async () => {
    const storage = fakeStorage();
    await expect(
      service.uploadSupplierInvoiceFile(fakePool, storage, 1, pdf({ mimetype: 'image/png' }))
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(
      service.uploadSupplierInvoiceFile(fakePool, storage, 1, pdf({ buffer: Buffer.from('<html>not a pdf</html>') }))
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    await expect(
      service.uploadSupplierInvoiceFile(fakePool, storage, 1, pdf({ buffer: Buffer.alloc(0) }))
    ).rejects.toMatchObject({ code: 'FILE_REQUIRED' });
    await expect(
      service.uploadSupplierInvoiceFile(fakePool, storage, 1, pdf({ truncated: true }))
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('stores the PDF, records its metadata, and removes the file it replaces', async () => {
    const storage = fakeStorage();
    repository.findSupplierInvoiceFile.mockResolvedValue({ key: 'purchase-invoices/1/old.pdf', name: 'old.pdf' });

    await service.uploadSupplierInvoiceFile(fakePool, storage, 1, pdf({ filename: 'C:\\fakepath\\inv-123.pdf' }));

    expect(storage.putObject).toHaveBeenCalledWith(
      expect.stringMatching(/^purchase-invoices\/1\/[0-9a-f-]+\.pdf$/),
      expect.any(Buffer),
      'application/pdf'
    );
    expect(repository.setSupplierInvoiceFile).toHaveBeenCalledWith(
      fakePool,
      1,
      expect.objectContaining({ name: 'inv-123.pdf', size: 13 })
    );
    expect(storage.deleteObject).toHaveBeenCalledWith('purchase-invoices/1/old.pdf');
  });

  it('a cancelled purchase cannot receive a new file', async () => {
    repository.findById.mockResolvedValue({ id: 1, status: 'CANCELLED' });

    await expect(service.uploadSupplierInvoiceFile(fakePool, fakeStorage(), 1, pdf())).rejects.toMatchObject({
      code: 'INVALID_STATUS'
    });
  });

  it('download returns the stored bytes, and 404 when there is no file', async () => {
    const storage = fakeStorage();
    storage.getObject.mockResolvedValue({ body: Buffer.from('%PDF-'), contentType: 'application/pdf' });
    repository.findSupplierInvoiceFile.mockResolvedValue({ key: 'purchase-invoices/1/a.pdf', name: 'a.pdf' });

    const file = await service.getSupplierInvoiceFile(fakePool, storage, 1);
    expect(file.filename).toBe('a.pdf');

    repository.findSupplierInvoiceFile.mockResolvedValue({ key: null, name: null });
    await expect(service.getSupplierInvoiceFile(fakePool, storage, 1)).rejects.toMatchObject({ statusCode: 404 });
  });
});
