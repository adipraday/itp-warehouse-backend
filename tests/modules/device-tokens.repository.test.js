import { describe, it, expect, vi } from 'vitest';
import * as repo from '../../src/modules/device-tokens/device-tokens.repository.js';

function fakeDb(rows = []) {
  return { execute: vi.fn().mockResolvedValue([rows]) };
}

describe('device-tokens.repository.findTokensForRole', () => {
  it('without a buId keeps the original role-wide lookup (no user_directory involved)', async () => {
    const db = fakeDb([{ user_id: 9, fcm_token: 't1' }]);
    expect(await repo.findTokensForRole(db, 'owner')).toEqual([{ user_id: 9, fcm_token: 't1' }]);

    const [sql, params] = db.execute.mock.calls[0];
    expect(sql).not.toMatch(/user_directory/);
    expect(params).toEqual(['owner']);
  });

  it('with a buId only returns devices whose owner token covers that BU, via user_directory', async () => {
    const db = fakeDb([{ user_id: 9, fcm_token: 't1' }]);
    await repo.findTokensForRole(db, 'owner', 6);

    const [sql, params] = db.execute.mock.calls[0];
    // INNER JOIN => a device whose user is not in user_directory is excluded (fail closed).
    expect(sql).toMatch(/JOIN user_directory ud ON ud\.user_id = dt\.user_id/);
    expect(sql).not.toMatch(/LEFT JOIN/);
    expect(sql).toMatch(/ud\.role = \?/);
    expect(sql).toMatch(/ud\.bu_ids IS NULL OR JSON_CONTAINS\(ud\.bu_ids, \?\)/);
    expect(params).toEqual(['owner', 'owner', '6']);
  });
});
