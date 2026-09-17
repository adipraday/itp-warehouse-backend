import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/payments/payments.repository.js';
import * as invoicesRepository from '../../src/modules/invoices/invoices.repository.js';
import * as cashSessionsRepository from '../../src/modules/cash-sessions/cash-sessions.repository.js';
import * as service from '../../src/modules/payments/payments.service.js';

vi.mock('../../src/modules/payments/payments.repository.js');
vi.mock('../../src/modules/invoices/invoices.repository.js');
vi.mock('../../src/modules/cash-sessions/cash-sessions.repository.js');
vi.mock('../../src/shared/database/transaction.js', () => ({
  withTransaction: vi.fn((pool, work) => work({}))
}));

const fakePool = {};

describe('payments.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('createPayment rejects when the invoice does not exist', async () => {
    invoicesRepository.findByIdForUpdate.mockResolvedValue(null);

    await expect(
      service.createPayment(fakePool, { invoice_id: 999, amount: 100, payment_method: 'cash', payment_date: '2026-08-25' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('createPayment rejects when the invoice is not COMPLETED', async () => {
    invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'DRAFT', total_amount: '100000.00' });

    await expect(
      service.createPayment(fakePool, { invoice_id: 1, amount: 50000, payment_method: 'cash', payment_date: '2026-08-25' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS' });
  });

  it('createPayment rejects when the amount exceeds the remaining balance', async () => {
    invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00' });
    repository.sumByInvoiceId.mockResolvedValue(80000);

    await expect(
      service.createPayment(fakePool, { invoice_id: 1, amount: 30000, payment_method: 'cash', payment_date: '2026-08-25' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'AMOUNT_EXCEEDS_BALANCE' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('createPayment marks the invoice PARTIAL when the balance is not fully covered', async () => {
    invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00' });
    repository.sumByInvoiceId.mockResolvedValue(0);
    repository.create.mockResolvedValue(1);
    invoicesRepository.updatePaymentStatus.mockResolvedValue();
    repository.findById.mockResolvedValue({ id: 1, invoice_id: 1, amount: '40000.00' });

    await service.createPayment(fakePool, { invoice_id: 1, amount: 40000, payment_method: 'cash', payment_date: '2026-08-25' });

    expect(invoicesRepository.updatePaymentStatus).toHaveBeenCalledWith(expect.anything(), 1, 'PARTIAL');
  });

  it('createPayment marks the invoice PAID when the payment covers the full remaining balance', async () => {
    invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00' });
    repository.sumByInvoiceId.mockResolvedValue(60000);
    repository.create.mockResolvedValue(2);
    invoicesRepository.updatePaymentStatus.mockResolvedValue();
    repository.findById.mockResolvedValue({ id: 2, invoice_id: 1, amount: '40000.00' });

    await service.createPayment(fakePool, { invoice_id: 1, amount: 40000, payment_method: 'transfer', payment_date: '2026-08-25' });

    expect(invoicesRepository.updatePaymentStatus).toHaveBeenCalledWith(expect.anything(), 1, 'PAID');
  });

  it('listInvoicePayments rejects when the invoice does not exist', async () => {
    invoicesRepository.findById.mockResolvedValue(null);

    await expect(service.listInvoicePayments(fakePool, 999, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  describe('amount_tendered / change_amount (2026-09-13)', () => {
    it('defaults amount_tendered to amount and change_amount to 0 when not sent', async () => {
      invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00', warehouse_id: 3 });
      repository.sumByInvoiceId.mockResolvedValue(0);
      cashSessionsRepository.findOpenByUserAndWarehouse.mockResolvedValue(null);
      repository.create.mockResolvedValue(1);
      invoicesRepository.updatePaymentStatus.mockResolvedValue();
      repository.findById.mockResolvedValue({ id: 1 });

      await service.createPayment(fakePool, { invoice_id: 1, amount: 40000, payment_method: 'CASH', payment_date: '2026-08-25' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount_tendered: 40000, change_amount: 0 }),
        null
      );
    });

    it('computes change_amount when amount_tendered is more than amount', async () => {
      invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00', warehouse_id: 3 });
      repository.sumByInvoiceId.mockResolvedValue(0);
      cashSessionsRepository.findOpenByUserAndWarehouse.mockResolvedValue(null);
      repository.create.mockResolvedValue(1);
      invoicesRepository.updatePaymentStatus.mockResolvedValue();
      repository.findById.mockResolvedValue({ id: 1 });

      await service.createPayment(fakePool, {
        invoice_id: 1,
        amount: 100000,
        amount_tendered: 200000,
        payment_method: 'CASH',
        payment_date: '2026-08-25'
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount_tendered: 200000, change_amount: 100000 }),
        null
      );
    });

    it('rejects amount_tendered lower than amount', async () => {
      await expect(
        service.createPayment(fakePool, {
          invoice_id: 1,
          amount: 100000,
          amount_tendered: 50000,
          payment_method: 'CASH',
          payment_date: '2026-08-25'
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'AMOUNT_TENDERED_TOO_LOW' });
      expect(invoicesRepository.findByIdForUpdate).not.toHaveBeenCalled();
    });
  });

  describe('cash_session_id auto-tagging (2026-09-13)', () => {
    it('tags the payment with the cashier\'s open session at the invoice\'s warehouse', async () => {
      invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00', warehouse_id: 3 });
      repository.sumByInvoiceId.mockResolvedValue(0);
      cashSessionsRepository.findOpenByUserAndWarehouse.mockResolvedValue({ id: 42, warehouse_id: 3 });
      repository.create.mockResolvedValue(1);
      invoicesRepository.updatePaymentStatus.mockResolvedValue();
      repository.findById.mockResolvedValue({ id: 1, cash_session_id: 42 });

      await service.createPayment(fakePool, { invoice_id: 1, amount: 40000, payment_method: 'CASH', payment_date: '2026-08-25' }, 501);

      expect(cashSessionsRepository.findOpenByUserAndWarehouse).toHaveBeenCalledWith(expect.anything(), 501, 3);
      expect(repository.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ cash_session_id: 42 }),
        501
      );
    });

    it('leaves cash_session_id null when the cashier has no open session (e.g. finance settling a B2B invoice)', async () => {
      invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00', warehouse_id: 3 });
      repository.sumByInvoiceId.mockResolvedValue(0);
      cashSessionsRepository.findOpenByUserAndWarehouse.mockResolvedValue(null);
      repository.create.mockResolvedValue(1);
      invoicesRepository.updatePaymentStatus.mockResolvedValue();
      repository.findById.mockResolvedValue({ id: 1, cash_session_id: null });

      await service.createPayment(fakePool, { invoice_id: 1, amount: 40000, payment_method: 'transfer', payment_date: '2026-08-25' }, 700);

      expect(repository.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cash_session_id: null }), 700);
    });

    it('never looks up a session when there is no identity (userId undefined) — legacy/no-auth callers', async () => {
      invoicesRepository.findByIdForUpdate.mockResolvedValue({ id: 1, status: 'COMPLETED', total_amount: '100000.00', warehouse_id: 3 });
      repository.sumByInvoiceId.mockResolvedValue(0);
      repository.create.mockResolvedValue(1);
      invoicesRepository.updatePaymentStatus.mockResolvedValue();
      repository.findById.mockResolvedValue({ id: 1, cash_session_id: null });

      await service.createPayment(fakePool, { invoice_id: 1, amount: 40000, payment_method: 'cash', payment_date: '2026-08-25' });

      expect(cashSessionsRepository.findOpenByUserAndWarehouse).not.toHaveBeenCalled();
    });
  });
});
