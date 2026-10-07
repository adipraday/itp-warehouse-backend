import { describe, it, expect, vi } from 'vitest';
import { createBusinessUnitResolver } from '../../src/shared/auth/business-unit-resolver.js';

const config = { AUTH_API_URL: 'http://auth.test', SERVICE_API_KEY: 'k' };

function setup(overrides = {}) {
  let t = 1_000;
  const fetchBusinessUnit = vi.fn().mockResolvedValue({ id: 1, name: 'Sawah Dangka Mart', code: 'sdm-01', status: 'ACTIVE' });
  const resolve = createBusinessUnitResolver({
    ttlMs: 60_000,
    failureTtlMs: 5_000,
    now: () => t,
    fetchBusinessUnit,
    ...overrides
  });
  return {
    resolve,
    fetchBusinessUnit,
    advance: (ms) => {
      t += ms;
    }
  };
}

describe('createBusinessUnitResolver', () => {
  it('returns just {id, name} (never leaks the rest of the auth-backend record)', async () => {
    const { resolve } = setup();
    expect(await resolve(config, 1)).toEqual({ id: 1, name: 'Sawah Dangka Mart' });
  });

  it('caches within the TTL and refetches after it', async () => {
    const { resolve, fetchBusinessUnit, advance } = setup();
    await resolve(config, 1);
    advance(59_000);
    await resolve(config, 1);
    expect(fetchBusinessUnit).toHaveBeenCalledTimes(1);

    advance(1_000);
    await resolve(config, 1);
    expect(fetchBusinessUnit).toHaveBeenCalledTimes(2);
  });

  it('caches per business unit', async () => {
    const { resolve, fetchBusinessUnit } = setup();
    await resolve(config, 1);
    await resolve(config, 2);
    expect(fetchBusinessUnit).toHaveBeenCalledTimes(2);
  });

  it('returns null without calling out for a missing buId or config', async () => {
    const { resolve, fetchBusinessUnit } = setup();
    expect(await resolve(config, null)).toBeNull();
    expect(await resolve(undefined, 1)).toBeNull();
    expect(fetchBusinessUnit).not.toHaveBeenCalled();
  });

  it('returns null for a business unit that does not exist', async () => {
    const { resolve } = setup({ fetchBusinessUnit: vi.fn().mockResolvedValue(null) });
    expect(await resolve(config, 99)).toBeNull();
  });

  it('never throws when auth-backend fails, and retries after the short failure TTL', async () => {
    const fetchBusinessUnit = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 auth down'))
      .mockResolvedValue({ id: 1, name: 'Sawah Dangka Mart' });
    const { resolve, advance } = setup({ fetchBusinessUnit });

    expect(await resolve(config, 1)).toBeNull();
    advance(4_000);
    expect(await resolve(config, 1)).toBeNull(); // still inside the failure TTL, no hammering
    expect(fetchBusinessUnit).toHaveBeenCalledTimes(1);

    advance(1_000);
    expect(await resolve(config, 1)).toEqual({ id: 1, name: 'Sawah Dangka Mart' });
    expect(fetchBusinessUnit).toHaveBeenCalledTimes(2);
  });
});
