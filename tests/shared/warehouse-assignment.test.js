import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerWarehouseAssignment, STAFF_ROLES } from '../../src/shared/auth/warehouse-assignment.js';

// Fake Fastify app: just enough for registerWarehouseAssignment() to attach
// its onRequest hook and for that hook to read app.db.
function makeApp(assignmentRows = []) {
  const hooks = {};
  return {
    db: { execute: vi.fn().mockResolvedValue([assignmentRows]) },
    addHook: (name, fn) => {
      hooks[name] = fn;
    },
    hooks
  };
}

function makeRequest(url, userContext) {
  return { url, userContext };
}

describe('registerWarehouseAssignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op for non-/api/* paths (health, docs)', async () => {
    const app = makeApp([]);
    await registerWarehouseAssignment(app);
    await expect(
      app.hooks.onRequest(makeRequest('/health', { userId: 1, role: 'staff-gudang' }))
    ).resolves.toBeUndefined();
    expect(app.db.execute).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no identity (hybrid/header lenient)', async () => {
    const app = makeApp([]);
    await registerWarehouseAssignment(app);
    await expect(app.hooks.onRequest(makeRequest('/api/items', null))).resolves.toBeUndefined();
    expect(app.db.execute).not.toHaveBeenCalled();
  });

  it.each(['super-admin', 'owner', 'admin-bu'])('is a no-op for exempt role %s', async (role) => {
    const app = makeApp([]);
    await registerWarehouseAssignment(app);
    const request = makeRequest('/api/items', { userId: 1, role });
    await expect(app.hooks.onRequest(request)).resolves.toBeUndefined();
    expect(app.db.execute).not.toHaveBeenCalled();
    expect(request.userContext.assignedWarehouseIds).toBeUndefined();
  });

  it.each(STAFF_ROLES)('blocks %s with zero assignments on a normal /api/* route', async (role) => {
    const app = makeApp([]); // no assignment rows
    await registerWarehouseAssignment(app);
    const request = makeRequest('/api/items', { userId: 42, role });
    await expect(app.hooks.onRequest(request)).rejects.toMatchObject({
      statusCode: 403,
      code: 'WAREHOUSE_ACCESS_NOT_CONFIGURED'
    });
  });

  it('lets a staff user with zero assignments still reach the status-check endpoint', async () => {
    const app = makeApp([]);
    await registerWarehouseAssignment(app);
    const request = makeRequest('/api/me/access-status', { userId: 42, role: 'staff-gudang' });
    await expect(app.hooks.onRequest(request)).resolves.toBeUndefined();
    expect(request.userContext.assignedWarehouseIds).toEqual([]);
  });

  it('populates assignedWarehouseIds and lets the request through when assignments exist', async () => {
    const app = makeApp([{ warehouse_id: 2 }, { warehouse_id: 5 }]);
    await registerWarehouseAssignment(app);
    const request = makeRequest('/api/stocks', { userId: 42, role: 'kasir-sales' });
    await expect(app.hooks.onRequest(request)).resolves.toBeUndefined();
    expect(request.userContext.assignedWarehouseIds).toEqual([2, 5]);
    expect(app.db.execute).toHaveBeenCalledWith(expect.stringContaining('user_warehouse_assignments'), [42]);
  });
});
