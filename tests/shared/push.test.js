import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  messaging: { sendEachForMulticast: vi.fn() },
  getMessaging: vi.fn(),
  tokens: {
    findTokensForRoleAndBu: vi.fn(),
    findTokensForRole: vi.fn(),
    findTokensForWarehouseStaff: vi.fn(),
    removeTokens: vi.fn()
  },
  notifications: { createForUsers: vi.fn() },
  directory: {
    findUserIdsForRoleAndBu: vi.fn(),
    findUserIdsForRole: vi.fn(),
    findUserIdsForWarehouseStaff: vi.fn()
  }
}));

vi.mock('../../src/shared/notifications/firebase-admin.js', () => ({ getMessaging: mocks.getMessaging }));
vi.mock('../../src/modules/device-tokens/device-tokens.repository.js', () => mocks.tokens);
vi.mock('../../src/modules/notifications/notifications.repository.js', () => mocks.notifications);
vi.mock('../../src/modules/user-directory/user-directory.repository.js', () => mocks.directory);

import {
  notifyRole,
  notifyAllWithRole,
  notifyWarehouseRoles,
  notifyStakeholders
} from '../../src/shared/notifications/push.js';

const db = { tag: 'db' };
const payload = { title: 'Stok Menipis', body: 'Kopi tersisa 2', data: { type: 'low_stock', item_id: 9 } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMessaging.mockReturnValue(mocks.messaging);
  mocks.messaging.sendEachForMulticast.mockResolvedValue({ responses: [{ success: true }] });
  for (const fn of Object.values(mocks.tokens)) fn.mockResolvedValue([]);
  for (const fn of Object.values(mocks.directory)) fn.mockResolvedValue([]);
  mocks.notifications.createForUsers.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('notifyRole — inbox recipients', () => {
  it('writes an inbox row for a directory user that has NO device token, and sends no push', async () => {
    mocks.directory.findUserIdsForRoleAndBu.mockResolvedValue([21]);

    await notifyRole(db, { role: 'admin-bu', buId: 3, ...payload });

    expect(mocks.directory.findUserIdsForRoleAndBu).toHaveBeenCalledWith(db, 'admin-bu', 3);
    expect(mocks.notifications.createForUsers).toHaveBeenCalledWith(db, [21], {
      title: payload.title,
      body: payload.body,
      type: 'low_stock',
      data: payload.data
    });
    expect(mocks.messaging.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('unions token holders and directory users, one row per user, and pushes only to tokens', async () => {
    mocks.tokens.findTokensForRoleAndBu.mockResolvedValue([
      { user_id: 10, fcm_token: 't-a' },
      { user_id: 10, fcm_token: 't-b' }, // same person, second device
      { user_id: 11, fcm_token: 't-c' }
    ]);
    mocks.directory.findUserIdsForRoleAndBu.mockResolvedValue([11, 12]); // 11 is in both

    await notifyRole(db, { role: 'admin-bu', buId: 3, ...payload });

    const [, userIds] = mocks.notifications.createForUsers.mock.calls[0];
    expect([...userIds].sort()).toEqual([10, 11, 12]);
    expect(mocks.messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(mocks.messaging.sendEachForMulticast.mock.calls[0][0].tokens).toEqual(['t-a', 't-b', 't-c']);
  });

  it('still writes the inbox when Firebase is not configured', async () => {
    mocks.getMessaging.mockReturnValue(null);
    mocks.tokens.findTokensForRoleAndBu.mockResolvedValue([{ user_id: 10, fcm_token: 't-a' }]);

    await notifyRole(db, { role: 'admin-bu', buId: 3, ...payload });

    expect(mocks.notifications.createForUsers).toHaveBeenCalledWith(db, [10], expect.any(Object));
  });

  it('does nothing when there is no buId or nobody matches', async () => {
    await notifyRole(db, { role: 'admin-bu', buId: null, ...payload });
    await notifyRole(db, { role: 'admin-bu', buId: 3, ...payload });

    expect(mocks.notifications.createForUsers).not.toHaveBeenCalled();
    expect(mocks.messaging.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('a failing directory lookup degrades to the token path instead of dropping the push', async () => {
    mocks.tokens.findTokensForRoleAndBu.mockResolvedValue([{ user_id: 10, fcm_token: 't-a' }]);
    mocks.directory.findUserIdsForRoleAndBu.mockRejectedValue(new Error("Table 'user_directory' doesn't exist"));

    await notifyRole(db, { role: 'admin-bu', buId: 3, ...payload });

    expect(mocks.notifications.createForUsers).toHaveBeenCalledWith(db, [10], expect.any(Object));
    expect(mocks.messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it('never throws even if the inbox write fails', async () => {
    mocks.directory.findUserIdsForRoleAndBu.mockResolvedValue([21]);
    mocks.notifications.createForUsers.mockRejectedValue(new Error('db down'));

    await expect(notifyRole(db, { role: 'admin-bu', buId: 3, ...payload })).resolves.toBeUndefined();
  });
});

describe('notifyAllWithRole / notifyWarehouseRoles / notifyStakeholders', () => {
  it('notifyAllWithRole scopes the directory side by buId when given', async () => {
    mocks.directory.findUserIdsForRole.mockResolvedValue([40]);

    await notifyAllWithRole(db, { role: 'owner', buId: 3, ...payload });

    expect(mocks.directory.findUserIdsForRole).toHaveBeenCalledWith(db, 'owner', 3);
    expect(mocks.tokens.findTokensForRole).toHaveBeenCalledWith(db, 'owner');
    expect(mocks.notifications.createForUsers).toHaveBeenCalledWith(db, [40], expect.any(Object));
  });

  it('notifyAllWithRole without a buId keeps the unscoped role-wide lookup', async () => {
    await notifyAllWithRole(db, { role: 'owner', ...payload });

    expect(mocks.directory.findUserIdsForRole).toHaveBeenCalledWith(db, 'owner', null);
  });

  it('notifyWarehouseRoles resolves staff through the warehouse assignment on both sides', async () => {
    mocks.directory.findUserIdsForWarehouseStaff.mockResolvedValue([55]);

    await notifyWarehouseRoles(db, { warehouseId: 9, roles: ['admin-warehouse'], ...payload });

    expect(mocks.directory.findUserIdsForWarehouseStaff).toHaveBeenCalledWith(db, 9, ['admin-warehouse']);
    expect(mocks.notifications.createForUsers).toHaveBeenCalledWith(db, [55], expect.any(Object));
  });

  it('notifyWarehouseRoles is a no-op without a warehouse or roles', async () => {
    await notifyWarehouseRoles(db, { warehouseId: null, roles: ['admin-warehouse'], ...payload });
    await notifyWarehouseRoles(db, { warehouseId: 9, roles: [], ...payload });

    expect(mocks.directory.findUserIdsForWarehouseStaff).not.toHaveBeenCalled();
  });

  it('notifyStakeholders fans out to admin-bu, extra roles, scoped owners and warehouse staff', async () => {
    await notifyStakeholders(db, {
      buId: 3,
      extraBuRoles: ['purchasing'],
      includeOwner: true,
      warehouseId: 9,
      warehouseRoles: ['admin-warehouse'],
      ...payload
    });

    expect(mocks.directory.findUserIdsForRoleAndBu).toHaveBeenCalledWith(db, 'admin-bu', 3);
    expect(mocks.directory.findUserIdsForRoleAndBu).toHaveBeenCalledWith(db, 'purchasing', 3);
    expect(mocks.directory.findUserIdsForRole).toHaveBeenCalledWith(db, 'owner', 3);
    expect(mocks.directory.findUserIdsForWarehouseStaff).toHaveBeenCalledWith(db, 9, ['admin-warehouse']);
  });
});
