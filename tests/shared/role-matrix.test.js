import { describe, it, expect } from 'vitest';
import { can, guard, ROLES, HPP_VISIBLE_ROLES } from '../../src/shared/auth/role-matrix.js';

describe('role-matrix can()', () => {
  it('lets super-admin do anything, including unknown resources', () => {
    expect(can('super-admin', 'sales', 'write')).toBe(true);
    expect(can('super-admin', 'nonexistent-resource', 'write')).toBe(true);
  });

  it('denies by default for a resource not in the matrix', () => {
    expect(can('admin-bu', 'nonexistent-resource', 'write')).toBe(false);
  });

  it('allows a role listed under the specific action', () => {
    expect(can('admin-bu', 'stock-transfers', 'approve')).toBe(true);
    expect(can('staff-gudang', 'stock-transfers', 'approve')).toBe(false);
  });

  it('falls back to the resource write list when the action has no specific entry', () => {
    // sales only defines "write"; asking for an unlisted action falls back to it.
    expect(can('kasir-sales', 'sales', 'write')).toBe(true);
  });

  it('denies a role not present in the resolved allow-list', () => {
    expect(can('finance', 'sales', 'write')).toBe(false);
  });

  it('falls back to DEFAULT_WRITE_ROLES for a "read-only" resource with an empty rule object', () => {
    // stocks/dashboard/etc. are listed with `{}` because no write route exists for
    // them today. can() itself doesn't special-case "empty" — resourceRules.write
    // is undefined, so it falls through to DEFAULT_WRITE_ROLES (['admin-bu']).
    // This only matters if a write route is ever added without its own MATRIX entry.
    expect(can('admin-bu', 'stocks', 'write')).toBe(true);
    expect(can('kasir-sales', 'stocks', 'write')).toBe(false);
  });

  it('every declared role is a plain string and the list has no duplicates', () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });
});

describe('HPP_VISIBLE_ROLES', () => {
  it('excludes staff-gudang and kasir-sales, per the 2026-08-28 decision', () => {
    expect(HPP_VISIBLE_ROLES).not.toContain('staff-gudang');
    expect(HPP_VISIBLE_ROLES).not.toContain('kasir-sales');
  });

  it('includes super-admin, owner, admin-bu, purchasing and finance', () => {
    expect(HPP_VISIBLE_ROLES.sort()).toEqual(
      ['admin-bu', 'finance', 'owner', 'purchasing', 'super-admin'].sort()
    );
  });
});

// Multi-tenant (2026-09-08, docs/auth-multitenant-coordination.md §6, B1):
// owner is deliberately view-only — present in ROLES + HPP_VISIBLE_ROLES, absent
// from every write/approve/submit matrix entry, and NOT short-circuited in can()
// the way super-admin is.
describe('owner role (view-only)', () => {
  it('is declared in ROLES', () => {
    expect(ROLES).toContain('owner');
  });

  it('can see HPP/profit data', () => {
    expect(HPP_VISIBLE_ROLES).toContain('owner');
  });

  it('is denied every write action across every resource in the matrix', () => {
    const resources = [
      'warehouses', 'items', 'contacts', 'inbounds', 'outbounds', 'stock-transfers',
      'stock-opnames', 'returns', 'sales', 'purchases', 'payments'
    ];
    for (const resource of resources) {
      expect(can('owner', resource, 'write')).toBe(false);
    }
  });

  it('is denied approve/submit sub-actions too', () => {
    expect(can('owner', 'stock-transfers', 'approve')).toBe(false);
    expect(can('owner', 'stock-opnames', 'submit')).toBe(false);
    expect(can('owner', 'returns', 'approve')).toBe(false);
    expect(can('owner', 'returns', 'reject')).toBe(false);
  });

  it('is denied on an unknown resource (no super-admin-style short-circuit)', () => {
    expect(can('owner', 'nonexistent-resource', 'write')).toBe(false);
  });
});

describe('role-matrix guard()', () => {
  function makeRequest(userContext) {
    return { userContext };
  }

  it('is a no-op when there is no identity (hybrid/header lenient mode)', async () => {
    const hook = guard('sales', 'write');
    await expect(hook(makeRequest(null))).resolves.toBeUndefined();
    await expect(hook(makeRequest({ userId: null, role: null, buId: null }))).resolves.toBeUndefined();
  });

  it('passes through for an allowed role', async () => {
    const hook = guard('sales', 'write');
    await expect(
      hook(makeRequest({ userId: 1, role: 'kasir-sales', buId: 11 }))
    ).resolves.toBeUndefined();
  });

  it('throws a 403 FORBIDDEN for a disallowed role', async () => {
    const hook = guard('sales', 'write');
    await expect(hook(makeRequest({ userId: 1, role: 'finance', buId: 11 }))).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
  });

  it('lets super-admin through regardless of resource/action', async () => {
    const hook = guard('warehouses', 'write');
    await expect(
      hook(makeRequest({ userId: 1, role: 'super-admin', buId: null }))
    ).resolves.toBeUndefined();
  });

  it('defaults action to "write" when not specified', async () => {
    const hook = guard('payments');
    await expect(hook(makeRequest({ userId: 1, role: 'finance', buId: 11 }))).resolves.toBeUndefined();
    // kasir-sales is allowed to write payments (2026-09-13, needed for the
    // register workflow) — staff-gudang is a resource-neutral example of a
    // role that genuinely isn't in payments' allow-list, to keep testing the
    // "default action" behavior itself rather than this specific policy.
    await expect(
      hook(makeRequest({ userId: 1, role: 'staff-gudang', buId: 11 }))
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
