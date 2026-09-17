import { describe, it, expect } from 'vitest';
import { authorize, requireAuth } from '../../src/shared/auth/authorize.js';

function makeRequest(userContext) {
  return { userContext };
}

describe('authorize()', () => {
  it('throws 401 when there is no identity', async () => {
    const hook = authorize('admin-bu');
    await expect(hook(makeRequest(null))).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    await expect(hook(makeRequest({ userId: null, role: null, buId: null }))).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED'
    });
  });

  it('throws 403 when the role is not in the allow-list', async () => {
    const hook = authorize('admin-bu', 'super-admin');
    await expect(
      hook(makeRequest({ userId: 1, role: 'staff-gudang', buId: 11 }))
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('passes for a role in the allow-list', async () => {
    const hook = authorize('admin-bu', 'super-admin');
    await expect(
      hook(makeRequest({ userId: 1, role: 'admin-bu', buId: 11 }))
    ).resolves.toBeUndefined();
  });

  it('with no roles given, allows any authenticated identity regardless of role', async () => {
    const hook = authorize();
    await expect(
      hook(makeRequest({ userId: 1, role: 'kasir-sales', buId: 11 }))
    ).resolves.toBeUndefined();
  });

  it('requireAuth is the zero-role authorize() and still rejects a missing identity', async () => {
    await expect(requireAuth(makeRequest(null))).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      requireAuth(makeRequest({ userId: 7, role: 'finance', buId: null }))
    ).resolves.toBeUndefined();
  });
});
