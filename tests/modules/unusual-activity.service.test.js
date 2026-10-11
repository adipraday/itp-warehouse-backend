import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/dashboard/unusual-activity.repository.js';
import * as service from '../../src/modules/dashboard/unusual-activity.service.js';

vi.mock('../../src/modules/dashboard/unusual-activity.repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findCandidateRows: vi.fn(), countCreatesByUser: vi.fn() };
});

const db = {};
const period = { from: '2026-10-05', to: '2026-10-11' };

let nextId = 1;
function log(overrides = {}) {
  return {
    id: nextId++,
    user_id: 7,
    warehouse_id: 3,
    action: 'CANCEL',
    entity_type: 'SALE',
    entity_id: 100 + nextId,
    created_at: '2026-10-10 03:00:00.000',
    wib_hour: 10,
    ...overrides
  };
}

describe('unusual-activity.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    nextId = 1;
    repository.countCreatesByUser.mockResolvedValue(new Map());
  });

  it('flags nothing below the thresholds', async () => {
    repository.findCandidateRows.mockResolvedValue([log(), log(), log({ action: 'DELETE' })]);

    const { data } = await service.getUnusualActivity(db, period, [3]);

    expect(data.findings).toEqual([]);
    expect(data.summary).toMatchObject({ findings: 0, flagged_users: 0, high_severity: 0 });
    expect(data.thresholds.cancellations).toBe(3);
  });

  it('flags repeated cancellations with the person\'s cancel rate and keeps examples', async () => {
    repository.findCandidateRows.mockResolvedValue([
      log({ created_at: '2026-10-10 05:00:00.000' }),
      log({ created_at: '2026-10-09 05:00:00.000' }),
      log({ created_at: '2026-10-08 05:00:00.000' })
    ]);
    repository.countCreatesByUser.mockResolvedValue(new Map([[7, 12]]));

    const { data } = await service.getUnusualActivity(db, period, [3]);

    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]).toMatchObject({
      type: 'cancellations',
      user_id: 7,
      count: 3,
      severity: 'medium',
      warehouse_id: 3,
      documents_created: 12,
      cancel_rate_pct: 25,
      last_at: '2026-10-10 05:00:00.000',
      first_at: '2026-10-08 05:00:00.000'
    });
    expect(data.findings[0].examples).toHaveLength(3);
  });

  it('does not count cancellations of master data as transaction cancellations', async () => {
    repository.findCandidateRows.mockResolvedValue([
      log({ entity_type: 'ITEM' }),
      log({ entity_type: 'ITEM' }),
      log({ entity_type: 'ITEM' })
    ]);

    const { data } = await service.getUnusualActivity(db, period);
    expect(data.findings).toEqual([]);
  });

  it('marks double the threshold as high severity and ranks it first', async () => {
    repository.findCandidateRows.mockResolvedValue([
      ...Array.from({ length: 6 }, () => log({ user_id: 9, action: 'DELETE', entity_type: 'CONTACT' })),
      ...Array.from({ length: 3 }, () => log({ user_id: 7, action: 'DELETE', entity_type: 'CONTACT' }))
    ]);

    const { data } = await service.getUnusualActivity(db, period);

    expect(data.findings.map((f) => [f.user_id, f.severity])).toEqual([
      [9, 'high'],
      [7, 'medium']
    ]);
    expect(data.summary).toMatchObject({ findings: 2, flagged_users: 2, high_severity: 1 });
    expect(data.summary.by_type.deletions).toBe(2);
  });

  it('flags night-time transaction activity, but only inside the 22:00-05:00 window', async () => {
    repository.findCandidateRows.mockResolvedValue([
      log({ action: 'COMPLETE', entity_type: 'SALE', wib_hour: 23 }),
      log({ action: 'CREATE', entity_type: 'OUTBOUND', wib_hour: 2 }),
      log({ action: 'COMPLETE', entity_type: 'SALE', wib_hour: 12 }), // daytime: ignored
      log({ action: 'CREATE', entity_type: 'ITEM', wib_hour: 2 }) // master data: ignored
    ]);

    const { data } = await service.getUnusualActivity(db, period);

    const night = data.findings.find((f) => f.type === 'night_activity');
    expect(night).toMatchObject({ user_id: 7, count: 2 });
  });

  it('counts item edits and separates findings per person and per type', async () => {
    repository.findCandidateRows.mockResolvedValue([
      ...Array.from({ length: 5 }, () => log({ user_id: 4, action: 'UPDATE', entity_type: 'ITEM' })),
      ...Array.from({ length: 3 }, () => log({ user_id: 4, action: 'CANCEL', entity_type: 'PURCHASE' }))
    ]);

    const { data } = await service.getUnusualActivity(db, period);

    expect(data.findings.map((f) => f.type).sort()).toEqual(['cancellations', 'item_edits']);
    expect(data.summary.flagged_users).toBe(1);
  });

  it('defaults to the last 7 days and rejects bad ranges', async () => {
    repository.findCandidateRows.mockResolvedValue([]);

    const { data } = await service.getUnusualActivity(db, { to: '2026-10-11' });
    expect(data.period).toEqual({ from: '2026-10-05', to: '2026-10-11' });

    await expect(service.getUnusualActivity(db, { from: '2026-10-11', to: '2026-10-01' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_DATE_RANGE'
    });
    await expect(service.getUnusualActivity(db, { from: '2026-01-01', to: '2026-10-11' })).rejects.toMatchObject({
      statusCode: 400
    });
  });

  it('passes the caller scope and the WIB day window to the repository', async () => {
    repository.findCandidateRows.mockResolvedValue([]);

    await service.getUnusualActivity(db, period, [2, 3], null);

    expect(repository.findCandidateRows).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        from: '2026-10-05',
        toExclusive: '2026-10-12',
        buIds: [2, 3],
        assignedWarehouseIds: null,
        nightStartHour: 22,
        nightEndHour: 5
      })
    );
  });
});
