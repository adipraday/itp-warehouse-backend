import { getBusinessUnitById } from './business-units-client.js';

// Business-unit {id, name} for display (printed letterheads: BU name as the
// title, warehouse name under it). The frontend can't resolve this itself —
// auth-backend's GET /business-units/:id is 403 for every role except
// owner/super-admin — so warehouse-backend resolves it over the trusted
// service-key channel, same as the sales receipt does (sales.service.js).
//
// Differences from calling getBusinessUnitById() directly:
//   - cached (BU names almost never change; a printed doc must not cost an
//     auth-backend round-trip every time), and
//   - NEVER throws: this is decoration on a read endpoint, so an unreachable
//     or erroring auth-backend degrades to `null` ("name unknown") instead of
//     turning GET /warehouses/:id into a 502. A failure is cached only briefly
//     so a blip doesn't hide the name for the whole TTL.
export function createBusinessUnitResolver({
  ttlMs = 10 * 60 * 1000,
  failureTtlMs = 30 * 1000,
  now = Date.now,
  fetchBusinessUnit = getBusinessUnitById
} = {}) {
  const cache = new Map();

  return async function resolveBusinessUnit(config, buId) {
    if (!config || buId == null) return null;

    const hit = cache.get(buId);
    if (hit && hit.expiresAt > now()) return hit.value;

    try {
      const businessUnit = await fetchBusinessUnit(config, buId);
      const value = businessUnit ? { id: businessUnit.id, name: businessUnit.name } : null;
      cache.set(buId, { value, expiresAt: now() + ttlMs });
      return value;
    } catch {
      cache.set(buId, { value: null, expiresAt: now() + failureTtlMs });
      return null;
    }
  };
}

export const resolveBusinessUnit = createBusinessUnitResolver();
