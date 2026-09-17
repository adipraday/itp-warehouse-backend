import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/cash-sessions/cash-sessions.repository.js';
import * as service from '../../src/modules/cash-sessions/cash-sessions.service.js';

vi.mock('../../src/modules/cash-sessions/cash-sessions.repository.js');

const fakeDb = {};

function baseSession(overrides = {}) {
  return {
    id: 1,
    warehouse_id: 3,
    user_id: 501,
    status: 'OPEN',
    opening_amount: '100000.00',
    closing_amount: null,
    expected_cash_amount: null,
    cash_difference: null,
    ...overrides
  };
}

describe('cash-sessions.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repository.summaryByMethod.mockResolvedValue([]);
    repository.sumCashBySession.mockResolvedValue(0);
    repository.sumExpensesBySession.mockResolvedValue(0);
    repository.findExpensesBySession.mockResolvedValue([]);
  });

  describe('openCashSession', () => {
    it('opens a session when the user has none open yet', async () => {
      repository.findOpenByUser.mockResolvedValue(null);
      repository.create.mockResolvedValue(baseSession());

      const result = await service.openCashSession(fakeDb, { warehouse_id: 3, opening_amount: 100000 }, 501);

      expect(repository.create).toHaveBeenCalledWith(fakeDb, { warehouse_id: 3, opening_amount: 100000 }, 501);
      expect(result.data.status).toBe('OPEN');
    });

    it('throws 409 CASH_SESSION_ALREADY_OPEN when the user already has one open', async () => {
      repository.findOpenByUser.mockResolvedValue(baseSession({ id: 7 }));

      await expect(service.openCashSession(fakeDb, { warehouse_id: 3 }, 501)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CASH_SESSION_ALREADY_OPEN'
      });
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('closeCashSession', () => {
    it('throws 404 when the session does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.closeCashSession(fakeDb, 999, { closing_amount: 100000 })).rejects.toMatchObject({
        statusCode: 404
      });
    });

    it('throws 409 INVALID_STATUS when the session is already closed', async () => {
      repository.findById.mockResolvedValue(baseSession({ status: 'CLOSED' }));

      await expect(service.closeCashSession(fakeDb, 1, { closing_amount: 100000 })).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVALID_STATUS'
      });
    });

    it('computes expected_cash_amount and cash_difference from opening amount + cash payments', async () => {
      repository.findById.mockResolvedValue(baseSession({ opening_amount: '100000.00' }));
      repository.sumCashBySession.mockResolvedValue(250000); // cash payments during the shift
      repository.close.mockResolvedValue(baseSession({ status: 'CLOSED', closing_amount: '340000.00' }));

      await service.closeCashSession(fakeDb, 1, { closing_amount: 340000, notes: 'shift malam' });

      // expected = 100000 opening + 250000 cash in = 350000; actual counted = 340000 -> short by 10000
      expect(repository.close).toHaveBeenCalledWith(fakeDb, 1, {
        closing_amount: 340000,
        expected_cash_amount: '350000.00',
        cash_difference: '-10000.00',
        notes: 'shift malam'
      });
    });

    it('reports a positive cash_difference when there is MORE cash than expected', async () => {
      repository.findById.mockResolvedValue(baseSession({ opening_amount: '100000.00' }));
      repository.sumCashBySession.mockResolvedValue(200000);
      repository.close.mockResolvedValue(baseSession({ status: 'CLOSED' }));

      await service.closeCashSession(fakeDb, 1, { closing_amount: 310000 });

      expect(repository.close).toHaveBeenCalledWith(
        fakeDb,
        1,
        expect.objectContaining({ expected_cash_amount: '300000.00', cash_difference: '10000.00' })
      );
    });

    it('subtracts expenses from expected_cash_amount (2026-09-13)', async () => {
      repository.findById.mockResolvedValue(baseSession({ opening_amount: '100000.00' }));
      repository.sumCashBySession.mockResolvedValue(250000);
      repository.sumExpensesBySession.mockResolvedValue(30000); // e.g. "beli galon air"
      repository.close.mockResolvedValue(baseSession({ status: 'CLOSED' }));

      // expected = 100000 opening + 250000 cash in - 30000 expenses = 320000
      await service.closeCashSession(fakeDb, 1, { closing_amount: 320000 });

      expect(repository.close).toHaveBeenCalledWith(
        fakeDb,
        1,
        expect.objectContaining({ expected_cash_amount: '320000.00', cash_difference: '0.00' })
      );
    });
  });

  describe('addExpense (2026-09-13)', () => {
    it('throws 404 when the session does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.addExpense(fakeDb, 999, { amount: 10000, description: 'x' })).rejects.toMatchObject({
        statusCode: 404
      });
    });

    it('throws 409 INVALID_STATUS when the session is already CLOSED', async () => {
      repository.findById.mockResolvedValue(baseSession({ status: 'CLOSED' }));

      await expect(
        service.addExpense(fakeDb, 1, { amount: 10000, description: 'beli galon air' })
      ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS' });
      expect(repository.createExpense).not.toHaveBeenCalled();
    });

    it('rejects an expense larger than the cash currently expected in the drawer', async () => {
      repository.findById.mockResolvedValue(baseSession({ opening_amount: '100000.00' }));
      repository.sumCashBySession.mockResolvedValue(0); // no sales yet — only the 100000 float exists

      await expect(
        service.addExpense(fakeDb, 1, { amount: 150000, description: 'terlalu banyak' })
      ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_CASH_IN_DRAWER' });
      expect(repository.createExpense).not.toHaveBeenCalled();
    });

    it('records an expense within the available drawer cash', async () => {
      repository.findById
        .mockResolvedValueOnce(baseSession({ opening_amount: '100000.00' })) // pre-check fetch
        .mockResolvedValueOnce(baseSession({ opening_amount: '100000.00' })); // post-insert re-fetch
      repository.sumCashBySession.mockResolvedValue(50000);
      repository.createExpense.mockResolvedValue({ id: 1, amount: '30000.00', description: 'beli galon air' });

      await service.addExpense(fakeDb, 1, { amount: 30000, description: 'beli galon air' }, 501);

      expect(repository.createExpense).toHaveBeenCalledWith(
        fakeDb,
        { cash_session_id: 1, amount: 30000, description: 'beli galon air' },
        501
      );
    });

    it('a subsequent expense correctly accounts for previously recorded expenses', async () => {
      repository.findById.mockResolvedValue(baseSession({ opening_amount: '100000.00' }));
      repository.sumCashBySession.mockResolvedValue(0);
      repository.sumExpensesBySession.mockResolvedValue(60000); // already paid out 60000 earlier

      // Only 40000 left (100000 - 60000) — trying to pay out 50000 should fail.
      await expect(
        service.addExpense(fakeDb, 1, { amount: 50000, description: 'lagi-lagi galon' })
      ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_CASH_IN_DRAWER' });
    });
  });

  describe('getCashSession / getCurrentCashSession — summary enrichment', () => {
    it('getCashSession throws 404 for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getCashSession(fakeDb, 999)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('getCashSession attaches a by-method breakdown and live_expected_cash', async () => {
      repository.findById.mockResolvedValue(baseSession({ opening_amount: '100000.00' }));
      repository.summaryByMethod.mockResolvedValue([
        { method: 'CASH', count: 3, amount: '250000.00' },
        { method: 'QRIS', count: 2, amount: '150000.00' }
      ]);
      repository.sumCashBySession.mockResolvedValue(250000);

      const result = await service.getCashSession(fakeDb, 1);

      expect(result.data.summary).toEqual({
        by_method: [
          { method: 'CASH', count: 3, amount: '250000.00' },
          { method: 'QRIS', count: 2, amount: '150000.00' }
        ],
        total_amount: '400000.00',
        total_count: 5,
        expenses: [],
        total_expenses: '0.00',
        live_expected_cash: '350000.00'
      });
    });

    it('getCurrentCashSession returns null data when the user has no open session', async () => {
      repository.findOpenByUser.mockResolvedValue(null);

      const result = await service.getCurrentCashSession(fakeDb, 501);

      expect(result).toEqual({ data: null });
    });

    it('getCurrentCashSession returns the enriched session when one is open', async () => {
      repository.findOpenByUser.mockResolvedValue(baseSession());

      const result = await service.getCurrentCashSession(fakeDb, 501);

      expect(result.data.id).toBe(1);
      expect(result.data.summary).toBeDefined();
    });
  });
});
