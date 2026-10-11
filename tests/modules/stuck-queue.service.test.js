import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/dashboard/stuck-queue.repository.js';
import * as service from '../../src/modules/dashboard/stuck-queue.service.js';

vi.mock('../../src/modules/dashboard/stuck-queue.repository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findQueue: vi.fn(), countQueueByKind: vi.fn() };
});

const db = {};

describe('stuck-queue.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('every queue kind belongs to exactly one bucket', () => {
    expect(Object.keys(service.GROUP_OF_KIND).sort()).toEqual([...repository.QUEUE_KINDS].sort());
  });

  it('counts per kind and bucket, zero-fills kinds without documents, and maps rows', async () => {
    repository.countQueueByKind.mockResolvedValue([
      { kind: 'transfer_pending_approval', total: 2 },
      { kind: 'opname_pending_approval', total: 1 },
      { kind: 'sale_held', total: 3 }
    ]);
    repository.findQueue.mockResolvedValue([
      {
        kind: 'transfer_pending_approval',
        document_id: 4,
        document_number: 'TRF-000004',
        warehouse_id: 13,
        to_warehouse_id: 14,
        status: 'DRAFT',
        waiting_since: '2026-10-06 09:31:33.079',
        created_by: 23,
        age_days: '6'
      }
    ]);

    const { data } = await service.getStuckQueue(db, {}, [3], null);

    expect(data.min_age_days).toBe(2);
    expect(data.summary.total).toBe(6);
    expect(data.summary.by_group).toEqual({ approval: 3, completion: 0, draft: 0, held: 3 });
    expect(data.summary.by_kind.return_pending_completion).toBe(0);
    expect(data.summary.by_kind.sale_held).toBe(3);
    expect(data.summary.truncated).toBe(true); // 1 row returned of 6 pending
    expect(data.items[0]).toEqual({
      kind: 'transfer_pending_approval',
      group: 'approval',
      document_id: 4,
      document_number: 'TRF-000004',
      warehouse_id: 13,
      to_warehouse_id: 14,
      status: 'DRAFT',
      waiting_since: '2026-10-06 09:31:33.079',
      age_days: 6,
      created_by: 23
    });
  });

  it('passes age, limit, warehouse filter and the caller scope to both queries', async () => {
    repository.countQueueByKind.mockResolvedValue([]);
    repository.findQueue.mockResolvedValue([]);

    const { data } = await service.getStuckQueue(db, { min_age_days: 0, limit: 10, warehouse_id: 7 }, [2, 3], null);

    expect(data.summary).toMatchObject({ total: 0, truncated: false });
    const expectedScope = { warehouseId: 7, buIds: [2, 3], assignedWarehouseIds: null };
    expect(repository.findQueue).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ minAgeDays: 0, limit: 10, ...expectedScope })
    );
    expect(repository.countQueueByKind).toHaveBeenCalledWith(db, expect.objectContaining({ minAgeDays: 0, ...expectedScope }));
  });
});
