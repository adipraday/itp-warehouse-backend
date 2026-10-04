import { describe, it, expect, vi } from 'vitest';
import * as repo from '../../src/modules/user-directory/user-directory.repository.js';

function fakeDb(rows = []) {
  return { execute: vi.fn().mockResolvedValue([rows]) };
}

describe('user-directory.repository', () => {
  it('upsert serialises bu_ids to JSON and null-safes bu_id', async () => {
    const db = fakeDb();
    await repo.upsert(db, { user_id: 1, role: 'admin-bu', bu_id: 3, bu_ids: [3, 5] });
    await repo.upsert(db, { user_id: 2, role: 'super-admin', bu_id: undefined, bu_ids: null });

    expect(db.execute.mock.calls[0][1]).toEqual([1, 'admin-bu', 3, '[3,5]']);
    expect(db.execute.mock.calls[1][1]).toEqual([2, 'super-admin', null, null]);
    expect(db.execute.mock.calls[0][0]).toMatch(/ON DUPLICATE KEY UPDATE/);
  });

  it('findUserIdsForRoleAndBu matches the home BU or a BU in bu_ids and returns plain ids', async () => {
    const db = fakeDb([{ user_id: 7 }, { user_id: 8 }]);
    const ids = await repo.findUserIdsForRoleAndBu(db, 'admin-bu', 3);

    expect(ids).toEqual([7, 8]);
    const [sql, params] = db.execute.mock.calls[0];
    expect(sql).toMatch(/bu_id = \? OR JSON_CONTAINS\(bu_ids, \?\)/);
    expect(params).toEqual(['admin-bu', 3, '3']);
  });

  it('findUserIdsForRole without a buId is role-wide, with a buId it is narrowed by bu_ids', async () => {
    const wide = fakeDb([{ user_id: 40 }]);
    await repo.findUserIdsForRole(wide, 'owner');
    expect(wide.execute.mock.calls[0][0]).not.toMatch(/JSON_CONTAINS/);
    expect(wide.execute.mock.calls[0][1]).toEqual(['owner']);

    const scoped = fakeDb([{ user_id: 40 }]);
    expect(await repo.findUserIdsForRole(scoped, 'owner', 4)).toEqual([40]);
    expect(scoped.execute.mock.calls[0][0]).toMatch(/bu_ids IS NULL OR JSON_CONTAINS\(bu_ids, \?\)/);
    expect(scoped.execute.mock.calls[0][1]).toEqual(['owner', '4']);
  });

  it('findUserIdsForWarehouseStaff joins the warehouse assignments and skips the query for no roles', async () => {
    const db = fakeDb([{ user_id: 55 }]);
    expect(await repo.findUserIdsForWarehouseStaff(db, 9, ['admin-warehouse', 'staff-gudang'])).toEqual([55]);
    const [sql, params] = db.execute.mock.calls[0];
    expect(sql).toMatch(/JOIN user_warehouse_assignments/);
    expect(sql).toMatch(/IN \(\?,\?\)/);
    expect(params).toEqual([9, 'admin-warehouse', 'staff-gudang']);

    const none = fakeDb();
    expect(await repo.findUserIdsForWarehouseStaff(none, 9, [])).toEqual([]);
    expect(none.execute).not.toHaveBeenCalled();
  });
});
