import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as userDirectory from '../../src/modules/user-directory/user-directory.repository.js';
import * as ownerInsights from '../../src/modules/dashboard/owner-insights.service.js';
import * as repository from '../../src/modules/owner-digest/owner-digest.repository.js';
import * as push from '../../src/shared/notifications/push.js';
import * as service from '../../src/modules/owner-digest/owner-digest.service.js';
import { addDays, businessDate, businessHour } from '../../src/shared/utils/business-time.js';

vi.mock('../../src/modules/user-directory/user-directory.repository.js');
vi.mock('../../src/modules/dashboard/owner-insights.service.js');
vi.mock('../../src/modules/owner-digest/owner-digest.repository.js');
vi.mock('../../src/shared/notifications/push.js');

const db = {};
const log = { warn: vi.fn() };

function totals(overrides = {}) {
  return {
    sales_count: 12,
    sales_total: '1250000.00',
    sales_growth_pct: 8,
    revenue: '1100000.00',
    gross_margin_pct: 24.5,
    low_stock_count: 5,
    out_of_stock_count: 3,
    ...overrides
  };
}

function cashSummary(overrides = {}) {
  return {
    sessions_closed: 4,
    sessions_with_variance: 0,
    total_shortage: '0.00',
    total_overage: '0.00',
    overdue_open_count: 0,
    ...overrides
  };
}

describe('business-time', () => {
  it('treats the UTC evening as already tomorrow in WIB', () => {
    const at = new Date('2026-10-11T18:16:00Z'); // 01:16 on 12 Oct in Jakarta
    expect(businessDate(at)).toBe('2026-10-12');
    expect(businessHour(at)).toBe(1);
  });

  it('keeps the same day before 17:00 UTC and rolls months with addDays', () => {
    expect(businessDate(new Date('2026-10-11T16:59:00Z'))).toBe('2026-10-11');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('formatDigest', () => {
  it('summarises a normal day with sales, margin, best branch, cash and stock', () => {
    const digest = service.formatDigest({
      date: '2026-10-11',
      branches: {
        totals: totals(),
        branches: [
          { name: 'Cabang 1', sales_total: '900000.00' },
          { name: 'Pusat', sales_total: '350000.00' }
        ]
      },
      cash: { summary: cashSummary({ sessions_with_variance: 1, total_shortage: '50000.00', overdue_open_count: 2 }) }
    });

    expect(digest.title).toBe('Ringkasan 11 Okt 2026');
    expect(digest.data).toEqual({ type: 'owner_digest', date: '2026-10-11' });
    expect(digest.body).toContain('Penjualan Rp 1.250.000 (12 transaksi, naik 8% dari hari sebelumnya).');
    expect(digest.body).toContain('Margin 24.5%.');
    expect(digest.body).toContain('Terbaik: Cabang 1.');
    expect(digest.body).toContain('Kas: 1 sesi berselisih (kurang Rp 50.000).');
    expect(digest.body).toContain('2 sesi kasir belum ditutup lebih dari 24 jam.');
    expect(digest.body).toContain('Stok: 3 habis, 5 menipis.');
  });

  it('stays short on a quiet day and omits growth when there is no baseline', () => {
    const quiet = service.formatDigest({
      date: '2026-10-11',
      branches: { totals: totals({ sales_count: 0, low_stock_count: 0, out_of_stock_count: 0 }), branches: [] },
      cash: { summary: cashSummary({ sessions_closed: 0 }) }
    });
    expect(quiet.body).toBe('Tidak ada penjualan.');

    const noBaseline = service.formatDigest({
      date: '2026-10-11',
      branches: {
        totals: totals({ sales_growth_pct: null, low_stock_count: 0, out_of_stock_count: 0 }),
        branches: [{ name: 'Satu-satunya', sales_total: '1250000.00' }]
      },
      cash: { summary: cashSummary() }
    });
    const onlyLow = service.formatDigest({
      date: '2026-10-11',
      branches: { totals: totals({ sales_count: 0, low_stock_count: 1, out_of_stock_count: 0 }), branches: [] },
      cash: { summary: cashSummary({ sessions_closed: 0 }) }
    });
    expect(onlyLow.body).toBe('Tidak ada penjualan. Stok: 1 menipis.');

    expect(noBaseline.body).toBe('Penjualan Rp 1.250.000 (12 transaksi). Margin 24.5%. Kas: semua sesi cocok.');
  });
});

describe('runOwnerDigest', () => {
  const morning = new Date('2026-10-11T23:30:00Z'); // 06:30 WIB on 12 Oct — before the hour
  const sendTime = new Date('2026-10-12T01:00:00Z'); // 08:00 WIB on 12 Oct

  beforeEach(() => {
    vi.resetAllMocks();
    userDirectory.findUsersByRole.mockResolvedValue([
      { user_id: 4, bu_ids: [2, 3] },
      { user_id: 9, bu_ids: [1, 6] }
    ]);
    repository.claim.mockResolvedValue(true);
    repository.release.mockResolvedValue();
    ownerInsights.getBranchComparison.mockResolvedValue({
      data: { totals: totals(), branches: [{ name: 'Cabang 1', sales_total: '900000.00' }] }
    });
    ownerInsights.getCashVariance.mockResolvedValue({ data: { summary: cashSummary() } });
    push.notifyUsers.mockResolvedValue();
  });

  it('does nothing before the send hour', async () => {
    expect(await service.runOwnerDigest(db, { now: morning, sendHour: 7, log })).toBe(0);
    expect(userDirectory.findUsersByRole).not.toHaveBeenCalled();
  });

  it('does nothing late in the evening, so yesterday is never reported at night', async () => {
    const night = new Date('2026-10-12T15:00:00Z'); // 22:00 WIB
    expect(await service.runOwnerDigest(db, { now: night, sendHour: 7, log })).toBe(0);
  });

  it('sends each owner their own digest about yesterday, scoped to their own BUs', async () => {
    const sent = await service.runOwnerDigest(db, { now: sendTime, sendHour: 7, log });

    expect(sent).toBe(2);
    expect(repository.claim).toHaveBeenCalledWith(db, 4, '2026-10-11');
    expect(repository.claim).toHaveBeenCalledWith(db, 9, '2026-10-11');
    expect(ownerInsights.getBranchComparison).toHaveBeenCalledWith(db, { from: '2026-10-11', to: '2026-10-11' }, [2, 3], null);
    expect(ownerInsights.getBranchComparison).toHaveBeenCalledWith(db, { from: '2026-10-11', to: '2026-10-11' }, [1, 6], null);
    expect(push.notifyUsers).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ userIds: [4], title: 'Ringkasan 11 Okt 2026' })
    );
  });

  it('skips an owner whose day was already claimed (no duplicate on restart or catch-up)', async () => {
    repository.claim.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await service.runOwnerDigest(db, { now: sendTime, sendHour: 7, log })).toBe(1);
    expect(push.notifyUsers).toHaveBeenCalledTimes(1);
    expect(push.notifyUsers).toHaveBeenCalledWith(db, expect.objectContaining({ userIds: [9] }));
  });

  it('gives the claim back when sending fails, so the next tick retries', async () => {
    push.notifyUsers.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce();

    expect(await service.runOwnerDigest(db, { now: sendTime, sendHour: 7, log })).toBe(1);
    expect(repository.release).toHaveBeenCalledWith(db, 4, '2026-10-11');
    expect(repository.release).not.toHaveBeenCalledWith(db, 9, '2026-10-11');
  });

  it('never claims or sends for an owner without a BU scope', async () => {
    userDirectory.findUsersByRole.mockResolvedValue([
      { user_id: 4, bu_ids: null },
      { user_id: 5, bu_ids: [] }
    ]);

    expect(await service.runOwnerDigest(db, { now: sendTime, sendHour: 7, log })).toBe(0);
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('sends nothing for an owner with no warehouses in scope', async () => {
    ownerInsights.getBranchComparison.mockResolvedValue({ data: { totals: totals(), branches: [] } });

    expect(await service.runOwnerDigest(db, { now: sendTime, sendHour: 7, log })).toBe(0);
    expect(push.notifyUsers).not.toHaveBeenCalled();
  });
});
