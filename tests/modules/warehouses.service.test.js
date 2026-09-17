import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/warehouses/warehouses.repository.js';
import * as businessUnitsClient from '../../src/shared/auth/business-units-client.js';
import * as service from '../../src/modules/warehouses/warehouses.service.js';

vi.mock('../../src/modules/warehouses/warehouses.repository.js');
vi.mock('../../src/shared/auth/business-units-client.js');

const fakeDb = {};
const fakeConfig = { AUTH_API_URL: 'http://auth.test', SERVICE_API_KEY: 'test-key' };

describe('warehouses.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('listWarehouses returns a paginated envelope', async () => {
    repository.findAll.mockResolvedValue([{ id: 1, code: 'WH-1', name: 'Gudang Utama' }]);
    repository.count.mockResolvedValue(1);

    const result = await service.listWarehouses(fakeDb, { page: '1', per_page: '20' });

    expect(result).toEqual({
      data: [{ id: 1, code: 'WH-1', name: 'Gudang Utama' }],
      meta: { page: 1, per_page: 20, total: 1 }
    });
    expect(repository.findAll).toHaveBeenCalledWith(fakeDb, {
      limit: 20,
      offset: 0,
      buIds: null,
      assignedWarehouseIds: null
    });
  });

  it('getWarehouse throws a 404 NotFoundError when the warehouse does not exist', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.getWarehouse(fakeDb, 999)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND'
    });
  });

  it('createWarehouse throws a 409 ConflictError when the code is already used', async () => {
    repository.findByCode.mockResolvedValue({ id: 1, code: 'WH-1' });

    await expect(
      service.createWarehouse(fakeDb, { code: 'WH-1', name: 'Gudang Baru' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'WAREHOUSE_CODE_EXISTS' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('createWarehouse creates the warehouse when the code is unused', async () => {
    repository.findByCode.mockResolvedValue(null);
    repository.create.mockResolvedValue({ id: 2, code: 'WH-2', name: 'Gudang Dua' });

    const result = await service.createWarehouse(fakeDb, { code: 'WH-2', name: 'Gudang Dua' });

    expect(result).toEqual({ data: { id: 2, code: 'WH-2', name: 'Gudang Dua' } });
  });

  it('updateWarehouse throws 404 when the warehouse does not exist', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(
      service.updateWarehouse(fakeDb, 999, { code: 'WH-1', name: 'Gudang 1' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updateWarehouse throws 409 when renaming to a code used by another warehouse', async () => {
    repository.findById.mockResolvedValue({ id: 1, code: 'WH-1', name: 'Gudang Lama' });
    repository.findByCode.mockResolvedValue({ id: 2, code: 'WH-2' });

    await expect(
      service.updateWarehouse(fakeDb, 1, { code: 'WH-2', name: 'Gudang Lama' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'WAREHOUSE_CODE_EXISTS' });
  });

  it('deleteWarehouse translates a MySQL FK violation into a 409 conflict', async () => {
    repository.findById.mockResolvedValue({ id: 1, code: 'WH-1' });
    const fkError = Object.assign(new Error('foreign key constraint fails'), { code: 'ER_ROW_IS_REFERENCED_2' });
    repository.remove.mockRejectedValue(fkError);

    await expect(service.deleteWarehouse(fakeDb, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'WAREHOUSE_REFERENCED'
    });
  });

  it('deleteWarehouse returns the deleted id when nothing references the warehouse', async () => {
    repository.findById.mockResolvedValue({ id: 1, code: 'WH-1' });
    repository.remove.mockResolvedValue();

    const result = await service.deleteWarehouse(fakeDb, 1);

    expect(result).toEqual({ data: { id: 1 } });
  });

  it('listWarehouseStocks throws 404 for an unknown warehouse', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.listWarehouseStocks(fakeDb, 999, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('getWarehouseStockSummary returns the repository summary', async () => {
    repository.findById.mockResolvedValue({ id: 1, code: 'WH-1' });
    repository.stockSummary.mockResolvedValue({
      warehouse_id: 1,
      total_items: 3,
      total_quantity: 42,
      low_stock_count: 1,
      out_of_stock_count: 0
    });

    const result = await service.getWarehouseStockSummary(fakeDb, 1);

    expect(result).toEqual({
      data: {
        warehouse_id: 1,
        total_items: 3,
        total_quantity: 42,
        low_stock_count: 1,
        out_of_stock_count: 0
      }
    });
  });
});

describe('warehouses.service — main/branch hierarchy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('createWarehouse', () => {
    it('creates a main warehouse (no parent_warehouse_id) with no extra lookups needed', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findMainWarehouseInBu.mockResolvedValue(null);
      repository.create.mockResolvedValue({ id: 1, code: 'WH-MAIN', bu_id: 11, parent_warehouse_id: null });

      const result = await service.createWarehouse(fakeDb, { code: 'WH-MAIN', name: 'Utama', bu_id: 11 });

      expect(result).toEqual({ data: { id: 1, code: 'WH-MAIN', bu_id: 11, parent_warehouse_id: null } });
      expect(repository.findMainWarehouseInBu).toHaveBeenCalledWith(fakeDb, 11, null);
    });

    it('rejects a 2nd main warehouse in the same BU with 409 MAIN_WAREHOUSE_EXISTS', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findMainWarehouseInBu.mockResolvedValue({ id: 5 });

      await expect(
        service.createWarehouse(fakeDb, { code: 'WH-MAIN2', name: 'Utama 2', bu_id: 11 })
      ).rejects.toMatchObject({ statusCode: 409, code: 'MAIN_WAREHOUSE_EXISTS' });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('creates a branch when the parent is a valid main warehouse in the same BU', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findById.mockResolvedValue({ id: 5, bu_id: 11, parent_warehouse_id: null });
      repository.create.mockResolvedValue({ id: 6, code: 'WH-BRANCH', bu_id: 11, parent_warehouse_id: 5 });

      const result = await service.createWarehouse(fakeDb, {
        code: 'WH-BRANCH',
        name: 'Cabang',
        bu_id: 11,
        parent_warehouse_id: 5
      });

      expect(result.data.parent_warehouse_id).toBe(5);
      // A branch doesn't compete for the "one main warehouse per BU" slot.
      expect(repository.findMainWarehouseInBu).not.toHaveBeenCalled();
    });

    it('rejects a parent that does not exist with 400 INVALID_PARENT_WAREHOUSE', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findById.mockResolvedValue(null);

      await expect(
        service.createWarehouse(fakeDb, { code: 'WH-BRANCH', name: 'Cabang', bu_id: 11, parent_warehouse_id: 999 })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PARENT_WAREHOUSE' });
    });

    it('rejects a parent that is itself a branch (depth > 2)', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findById.mockResolvedValue({ id: 6, bu_id: 11, parent_warehouse_id: 5 });

      await expect(
        service.createWarehouse(fakeDb, { code: 'WH-GRANDCHILD', name: 'Cucu', bu_id: 11, parent_warehouse_id: 6 })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PARENT_WAREHOUSE' });
    });

    it('rejects a parent that belongs to a different business unit', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findById.mockResolvedValue({ id: 5, bu_id: 12, parent_warehouse_id: null });

      await expect(
        service.createWarehouse(fakeDb, { code: 'WH-BRANCH', name: 'Cabang', bu_id: 11, parent_warehouse_id: 5 })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PARENT_WAREHOUSE' });
    });
  });

  describe('updateWarehouse', () => {
    it('rejects a warehouse being set as its own parent', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 11, parent_warehouse_id: null });

      await expect(
        service.updateWarehouse(fakeDb, 5, { code: 'WH-5', name: 'Utama', bu_id: 11, parent_warehouse_id: 5 })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PARENT_WAREHOUSE' });
    });

    it('rejects demoting a main warehouse to a branch while it still has children', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 11, parent_warehouse_id: null });
      repository.countChildren.mockResolvedValue(2);

      await expect(
        service.updateWarehouse(fakeDb, 5, { code: 'WH-5', name: 'Utama', bu_id: 11, parent_warehouse_id: 9 })
      ).rejects.toMatchObject({ statusCode: 409, code: 'WAREHOUSE_HAS_BRANCHES' });
    });

    it('rejects changing bu_id while the warehouse still has children', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 11, parent_warehouse_id: null });
      repository.countChildren.mockResolvedValue(1);

      await expect(
        service.updateWarehouse(fakeDb, 5, { code: 'WH-5', name: 'Utama', bu_id: 12 })
      ).rejects.toMatchObject({ statusCode: 409, code: 'WAREHOUSE_HAS_BRANCHES' });
    });

    it('allows changing bu_id when the warehouse has no children', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 11, parent_warehouse_id: null });
      repository.countChildren.mockResolvedValue(0);
      repository.findMainWarehouseInBu.mockResolvedValue(null);
      repository.update.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 12, parent_warehouse_id: null });

      await expect(
        service.updateWarehouse(fakeDb, 5, { code: 'WH-5', name: 'Utama', bu_id: 12 })
      ).resolves.toEqual({ data: { id: 5, code: 'WH-5', bu_id: 12, parent_warehouse_id: null } });
    });
  });

  describe('deleteWarehouse', () => {
    it('rejects deleting a main warehouse that still has branches, with 409 WAREHOUSE_HAS_BRANCHES', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5' });
      repository.countChildren.mockResolvedValue(2);

      await expect(service.deleteWarehouse(fakeDb, 5)).rejects.toMatchObject({
        statusCode: 409,
        code: 'WAREHOUSE_HAS_BRANCHES'
      });
      expect(repository.remove).not.toHaveBeenCalled();
    });

    it('deletes a warehouse with no branches as before', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5' });
      repository.countChildren.mockResolvedValue(0);
      repository.remove.mockResolvedValue();

      await expect(service.deleteWarehouse(fakeDb, 5)).resolves.toEqual({ data: { id: 5 } });
    });
  });
});

// Regression coverage for docs/bug-report-bu-id-mismatch.md: a bu_id must be confirmed
// against the auth-backend before it's trusted, never assumed correct just because a
// number was supplied.
describe('warehouses.service — bu_id validated against the auth-backend', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('createWarehouse', () => {
    it('validates bu_id against the auth-backend when config is provided', async () => {
      repository.findByCode.mockResolvedValue(null);
      businessUnitsClient.assertBusinessUnitIsUsable.mockResolvedValue();
      repository.findMainWarehouseInBu.mockResolvedValue(null);
      repository.create.mockResolvedValue({ id: 1, code: 'WH-1', bu_id: 13 });

      await service.createWarehouse(fakeDb, { code: 'WH-1', name: 'Utama', bu_id: 13 }, null, fakeConfig);

      expect(businessUnitsClient.assertBusinessUnitIsUsable).toHaveBeenCalledWith(fakeConfig, 13);
    });

    it('rejects when the auth-backend says the business unit is invalid/inactive', async () => {
      repository.findByCode.mockResolvedValue(null);
      const invalid = Object.assign(new Error('bad bu'), { statusCode: 400, code: 'INVALID_BUSINESS_UNIT' });
      businessUnitsClient.assertBusinessUnitIsUsable.mockRejectedValue(invalid);

      await expect(
        service.createWarehouse(fakeDb, { code: 'WH-1', name: 'Utama', bu_id: 999 }, null, fakeConfig)
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_BUSINESS_UNIT' });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('skips the auth-backend check entirely when no config is passed (existing unit-test callers)', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findMainWarehouseInBu.mockResolvedValue(null);
      repository.create.mockResolvedValue({ id: 1, code: 'WH-1', bu_id: 13 });

      await service.createWarehouse(fakeDb, { code: 'WH-1', name: 'Utama', bu_id: 13 });

      expect(businessUnitsClient.assertBusinessUnitIsUsable).not.toHaveBeenCalled();
    });
  });

  describe('updateWarehouse', () => {
    it('re-validates against the auth-backend only when bu_id is actually changing', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 13, parent_warehouse_id: null });
      repository.countChildren.mockResolvedValue(0);
      businessUnitsClient.assertBusinessUnitIsUsable.mockResolvedValue();
      repository.findMainWarehouseInBu.mockResolvedValue(null);
      repository.update.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 15 });

      await service.updateWarehouse(fakeDb, 5, { code: 'WH-5', name: 'Utama', bu_id: 15 }, fakeConfig);

      expect(businessUnitsClient.assertBusinessUnitIsUsable).toHaveBeenCalledWith(fakeConfig, 15);
    });

    it('does not call the auth-backend when bu_id is unchanged', async () => {
      repository.findById.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 13, parent_warehouse_id: null });
      repository.update.mockResolvedValue({ id: 5, code: 'WH-5', bu_id: 13 });

      await service.updateWarehouse(fakeDb, 5, { code: 'WH-5', name: 'Utama', bu_id: 13 }, fakeConfig);

      expect(businessUnitsClient.assertBusinessUnitIsUsable).not.toHaveBeenCalled();
    });
  });
});

// Auto-provisioning feature (2026-09-08): "ensure this BU has a main warehouse."
describe('warehouses.service — provisionDefaultWarehouse', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates a new main warehouse named after the BU when none exists yet', async () => {
    businessUnitsClient.assertBusinessUnitIsUsable.mockResolvedValue();
    repository.findMainWarehouseInBu.mockResolvedValue(null);
    businessUnitsClient.getBusinessUnitById.mockResolvedValue({ id: 28, code: 'bu-wh-ckr-01', name: 'Warehouse Cakrawala Pusat' });
    repository.findByCode.mockResolvedValue(null);
    repository.create.mockResolvedValue({ id: 10, code: 'WH-BU-WH-CKR-01', bu_id: 28, parent_warehouse_id: null });

    const result = await service.provisionDefaultWarehouse(fakeDb, 28, 1, fakeConfig);

    expect(repository.create).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        code: 'WH-BU-WH-CKR-01',
        name: 'Gudang Utama Warehouse Cakrawala Pusat',
        bu_id: 28,
        parent_warehouse_id: null
      }),
      1
    );
    expect(result).toEqual({ data: { id: 10, code: 'WH-BU-WH-CKR-01', bu_id: 28, parent_warehouse_id: null }, created: true });
  });

  it('is idempotent — returns the existing main warehouse untouched, does not create a second one', async () => {
    businessUnitsClient.assertBusinessUnitIsUsable.mockResolvedValue();
    repository.findMainWarehouseInBu.mockResolvedValue({ id: 5 });
    repository.findById.mockResolvedValue({ id: 5, code: 'WH-PUSAT', bu_id: 13, parent_warehouse_id: null });

    const result = await service.provisionDefaultWarehouse(fakeDb, 13, 1, fakeConfig);

    expect(repository.create).not.toHaveBeenCalled();
    expect(result).toEqual({ data: { id: 5, code: 'WH-PUSAT', bu_id: 13, parent_warehouse_id: null }, created: false });
  });

  it('appends a numeric suffix if the derived code already collides', async () => {
    businessUnitsClient.assertBusinessUnitIsUsable.mockResolvedValue();
    repository.findMainWarehouseInBu.mockResolvedValue(null);
    businessUnitsClient.getBusinessUnitById.mockResolvedValue({ id: 28, code: 'CKR', name: 'Cakrawala' });
    repository.findByCode.mockImplementation(async (db, code) => (code === 'WH-CKR' ? { id: 99 } : null));
    repository.create.mockResolvedValue({ id: 10, code: 'WH-CKR-1', bu_id: 28 });

    await service.provisionDefaultWarehouse(fakeDb, 28, 1, fakeConfig);

    expect(repository.create).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ code: 'WH-CKR-1' }),
      1
    );
  });

  it('rejects a bu_id that does not exist/is INACTIVE, before touching the warehouses table', async () => {
    const invalid = Object.assign(new Error('bad bu'), { statusCode: 400, code: 'INVALID_BUSINESS_UNIT' });
    businessUnitsClient.assertBusinessUnitIsUsable.mockRejectedValue(invalid);

    await expect(service.provisionDefaultWarehouse(fakeDb, 999, 1, fakeConfig)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_BUSINESS_UNIT'
    });
    expect(repository.findMainWarehouseInBu).not.toHaveBeenCalled();
  });

  it('skips the auth-backend check when no config is passed (unit-test callers)', async () => {
    repository.findMainWarehouseInBu.mockResolvedValue(null);
    repository.findByCode.mockResolvedValue(null);
    repository.create.mockResolvedValue({ id: 10, code: 'WH-BU-28', bu_id: 28 });

    await service.provisionDefaultWarehouse(fakeDb, 28, 1);

    expect(businessUnitsClient.assertBusinessUnitIsUsable).not.toHaveBeenCalled();
    expect(businessUnitsClient.getBusinessUnitById).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ code: 'WH-BU-28' }), 1);
  });
});
