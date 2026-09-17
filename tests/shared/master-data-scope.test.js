import { describe, it, expect, vi } from 'vitest';
import {
  assertRowInScope,
  assertItemsInScope,
  assertContactInScope
} from '../../src/shared/auth/master-data-scope.js';

function makeDb(rows) {
  return { execute: vi.fn().mockResolvedValue([rows]) };
}

describe('assertRowInScope', () => {
  it('is a no-op for a falsy row (lets 404 handling run first)', () => {
    expect(() => assertRowInScope(null, [11], 'item')).not.toThrow();
  });

  it('is a no-op for buIds null (super-admin)', () => {
    expect(() => assertRowInScope({ id: 1, bu_id: 99 }, null, 'item')).not.toThrow();
  });

  it('passes when the row\'s bu_id is in buIds', () => {
    expect(() => assertRowInScope({ id: 1, bu_id: 11 }, [11, 12], 'item')).not.toThrow();
  });

  it('throws 403 when the row\'s bu_id is outside buIds', () => {
    expect(() => assertRowInScope({ id: 1, bu_id: 99 }, [11, 12], 'item')).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' })
    );
  });

  it('throws 403 when the row is unassigned (bu_id null) and caller is not super-admin', () => {
    expect(() => assertRowInScope({ id: 1, bu_id: null }, [11], 'contact')).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });
});

describe('assertItemsInScope', () => {
  it('is a no-op for buIds null (super-admin)', async () => {
    const db = makeDb([]);
    await expect(assertItemsInScope(db, [1, 2], null)).resolves.toBeUndefined();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('is a no-op when itemIds is empty or all nullish', async () => {
    const db = makeDb([]);
    await assertItemsInScope(db, [null, undefined], [11]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('passes when every referenced item is in scope', async () => {
    const db = makeDb([
      { id: 1, bu_id: 11 },
      { id: 2, bu_id: 11 }
    ]);
    await expect(assertItemsInScope(db, [1, 2, 1], [11])).resolves.toBeUndefined();
  });

  it('throws 403 when any referenced item is outside scope', async () => {
    const db = makeDb([
      { id: 1, bu_id: 11 },
      { id: 2, bu_id: 99 }
    ]);
    await expect(assertItemsInScope(db, [1, 2], [11])).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
  });

  it('does not throw for an id with no matching row (nonexistent item, left to FK/validation)', async () => {
    const db = makeDb([]);
    await expect(assertItemsInScope(db, [999], [11])).resolves.toBeUndefined();
  });
});

describe('assertContactInScope', () => {
  it('is a no-op for buIds null or contactId null', async () => {
    const db = makeDb([]);
    await assertContactInScope(db, 5, null);
    await assertContactInScope(db, null, [11]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('passes for a contact in scope', async () => {
    const db = makeDb([{ id: 5, bu_id: 11 }]);
    await expect(assertContactInScope(db, 5, [11])).resolves.toBeUndefined();
  });

  it('throws 403 for a contact outside scope', async () => {
    const db = makeDb([{ id: 5, bu_id: 99 }]);
    await expect(assertContactInScope(db, 5, [11])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('does not throw for a nonexistent contact (left to FK/validation)', async () => {
    const db = makeDb([]);
    await expect(assertContactInScope(db, 999, [11])).resolves.toBeUndefined();
  });
});
