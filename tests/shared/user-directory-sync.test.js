import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock('../../src/modules/user-directory/user-directory.repository.js', () => repo);

import { createUserDirectoryRecorder } from '../../src/shared/auth/user-directory-sync.js';

const db = { tag: 'db' };
const admin = { userId: 7, role: 'admin-bu', buId: 3, buIds: [3, 5] };

beforeEach(() => {
  repo.upsert.mockReset();
  repo.upsert.mockResolvedValue(undefined);
});

describe('createUserDirectoryRecorder', () => {
  it('upserts a user the first time they are seen, mapping the verified claims', () => {
    const record = createUserDirectoryRecorder();
    record(db, admin);

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.upsert).toHaveBeenCalledWith(db, { user_id: 7, role: 'admin-bu', bu_id: 3, bu_ids: [3, 5] });
  });

  it('skips the write while the claims are unchanged and within the TTL', () => {
    let t = 1_000;
    const record = createUserDirectoryRecorder({ ttlMs: 60_000, now: () => t });
    record(db, admin);
    t += 59_000;
    record(db, admin);

    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the TTL even when nothing changed (keeps last_seen_at fresh)', () => {
    let t = 1_000;
    const record = createUserDirectoryRecorder({ ttlMs: 60_000, now: () => t });
    record(db, admin);
    t += 60_000;
    record(db, admin);

    expect(repo.upsert).toHaveBeenCalledTimes(2);
  });

  it('writes again immediately when role or BU claims change', () => {
    const record = createUserDirectoryRecorder();
    record(db, admin);
    record(db, { ...admin, role: 'admin-warehouse' });
    record(db, { ...admin, role: 'admin-warehouse', buIds: [3] });

    expect(repo.upsert).toHaveBeenCalledTimes(3);
  });

  it('does nothing without a db, a userId or a role', () => {
    const record = createUserDirectoryRecorder();
    record(undefined, admin);
    record(db, { ...admin, userId: null });
    record(db, { ...admin, role: null });
    record(db, null);

    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('never throws on a failed write, logs it, and retries on the next call', async () => {
    repo.upsert.mockRejectedValueOnce(new Error('db down'));
    const log = { warn: vi.fn() };
    const record = createUserDirectoryRecorder();

    expect(() => record(db, admin, log)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn).toHaveBeenCalledWith({ err: 'db down' }, 'user_directory upsert failed');

    record(db, admin, log); // failure cleared the cache entry, so this retries
    expect(repo.upsert).toHaveBeenCalledTimes(2);
  });

  it('keeps separate state per recorder instance', () => {
    createUserDirectoryRecorder()(db, admin);
    createUserDirectoryRecorder()(db, admin);

    expect(repo.upsert).toHaveBeenCalledTimes(2);
  });
});
