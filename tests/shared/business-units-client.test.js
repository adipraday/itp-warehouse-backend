import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getBusinessUnitById,
  findBusinessUnitByCode,
  assertBusinessUnitIsUsable
} from '../../src/shared/auth/business-units-client.js';

const config = { AUTH_API_URL: 'http://auth.test', SERVICE_API_KEY: 'test-key' };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe('business-units-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('getBusinessUnitById', () => {
    it('sends X-Service-Key and returns the business unit on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, { success: true, data: { business_unit: { id: 13, code: 'PUSAT', status: 'ACTIVE' } } })
      );

      const bu = await getBusinessUnitById(config, 13);

      expect(bu).toEqual({ id: 13, code: 'PUSAT', status: 'ACTIVE' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://auth.test/business-units/13',
        { headers: { 'X-Service-Key': 'test-key' } }
      );
    });

    it('returns null on 404 (business unit does not exist)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(404, {}));

      await expect(getBusinessUnitById(config, 999)).resolves.toBeNull();
    });

    it('throws a 502 BUSINESS_UNIT_SERVICE_UNAVAILABLE on a non-2xx/404 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(500, {}));

      await expect(getBusinessUnitById(config, 13)).rejects.toMatchObject({
        statusCode: 502,
        code: 'BUSINESS_UNIT_SERVICE_UNAVAILABLE'
      });
    });

    it('throws a 502 BUSINESS_UNIT_SERVICE_UNAVAILABLE when the network call itself fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(getBusinessUnitById(config, 13)).rejects.toMatchObject({
        statusCode: 502,
        code: 'BUSINESS_UNIT_SERVICE_UNAVAILABLE'
      });
    });
  });

  describe('findBusinessUnitByCode', () => {
    it('queries by code and returns the first match', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, { success: true, data: { business_units: [{ id: 13, code: 'PUSAT' }] } })
      );

      const bu = await findBusinessUnitByCode(config, 'PUSAT');

      expect(bu).toEqual({ id: 13, code: 'PUSAT' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://auth.test/business-units?code=PUSAT',
        { headers: { 'X-Service-Key': 'test-key' } }
      );
    });

    it('returns null when no business unit matches the code', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, { success: true, data: { business_units: [] } })
      );

      await expect(findBusinessUnitByCode(config, 'NOPE')).resolves.toBeNull();
    });

    it('URL-encodes the code', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, { success: true, data: { business_units: [] } })
      );

      await findBusinessUnitByCode(config, 'BU C&D');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://auth.test/business-units?code=BU%20C%26D',
        { headers: { 'X-Service-Key': 'test-key' } }
      );
    });
  });

  describe('assertBusinessUnitIsUsable', () => {
    it('is a no-op for buId null (unassigned is always valid)', async () => {
      globalThis.fetch = vi.fn();

      await expect(assertBusinessUnitIsUsable(config, null)).resolves.toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('passes for an ACTIVE business unit', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, { success: true, data: { business_unit: { id: 13, status: 'ACTIVE' } } })
      );

      await expect(assertBusinessUnitIsUsable(config, 13)).resolves.toBeUndefined();
    });

    it('throws 400 INVALID_BUSINESS_UNIT when the business unit does not exist', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(404, {}));

      await expect(assertBusinessUnitIsUsable(config, 999)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_BUSINESS_UNIT'
      });
    });

    it('throws 400 INVALID_BUSINESS_UNIT when the business unit is INACTIVE', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse(200, { success: true, data: { business_unit: { id: 13, status: 'INACTIVE' } } })
      );

      await expect(assertBusinessUnitIsUsable(config, 13)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_BUSINESS_UNIT'
      });
    });

    it('propagates a 502 when the auth-backend is unreachable, instead of silently passing', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(assertBusinessUnitIsUsable(config, 13)).rejects.toMatchObject({
        statusCode: 502,
        code: 'BUSINESS_UNIT_SERVICE_UNAVAILABLE'
      });
    });
  });
});
