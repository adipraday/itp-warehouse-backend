import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/items/items.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as service from '../../src/modules/items/items.service.js';

vi.mock('../../src/modules/items/items.repository.js');
vi.mock('../../src/modules/inventory/stocks/stocks.repository.js');

const fakeDb = {};

describe('items.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('listItems returns a paginated envelope', async () => {
    repository.findAll.mockResolvedValue([{ id: 1, sku: 'SKU-1', name: 'Router' }]);
    repository.count.mockResolvedValue(1);

    const result = await service.listItems(fakeDb, { page: '1', per_page: '20' });

    expect(result).toEqual({
      data: [{ id: 1, sku: 'SKU-1', name: 'Router' }],
      meta: { page: 1, per_page: 20, total: 1 }
    });
    expect(repository.findAll).toHaveBeenCalledWith(fakeDb, { limit: 20, offset: 0, buIds: null });
  });

  it('getItem throws a 404 NotFoundError when the item does not exist', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.getItem(fakeDb, 999)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND'
    });
  });

  it('createItem throws a 409 ConflictError when the sku is already used in that bu_id', async () => {
    repository.findBySkuInBu.mockResolvedValue({ id: 1, sku: 'SKU-1' });

    await expect(
      service.createItem(fakeDb, { sku: 'SKU-1', name: 'Router', unit: 'pcs', bu_id: 11 })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ITEM_SKU_EXISTS' });
    expect(repository.findBySkuInBu).toHaveBeenCalledWith(fakeDb, 'SKU-1', 11);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('createItem creates the item when the sku is unused', async () => {
    repository.findBySkuInBu.mockResolvedValue(null);
    repository.create.mockResolvedValue({ id: 2, sku: 'SKU-2', name: 'Switch' });

    const result = await service.createItem(fakeDb, { sku: 'SKU-2', name: 'Switch', unit: 'pcs' });

    expect(result).toEqual({ data: { id: 2, sku: 'SKU-2', name: 'Switch' } });
  });

  // Bug fix, 2026-09-14: SKU uniqueness is scoped per BU — two unrelated
  // business units may share the same SKU (docs/bug-report-*-cross-tenant-leak
  // is the same class of incident, on the write side this time).
  it('createItem allows the SAME sku across two DIFFERENT business units', async () => {
    repository.findBySkuInBu.mockResolvedValue(null); // no match within bu_id 15 — bu_id 13 having it is irrelevant
    repository.create.mockResolvedValue({ id: 3, sku: 'SKU-1', bu_id: 15 });

    await expect(
      service.createItem(fakeDb, { sku: 'SKU-1', name: 'Item lain', unit: 'pcs', bu_id: 15 })
    ).resolves.toEqual({ data: { id: 3, sku: 'SKU-1', bu_id: 15 } });
    expect(repository.findBySkuInBu).toHaveBeenCalledWith(fakeDb, 'SKU-1', 15);
  });

  it('updateItem throws 404 when the item does not exist', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(
      service.updateItem(fakeDb, 999, { sku: 'SKU-1', name: 'Router', unit: 'pcs' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updateItem throws 409 when renaming to a sku used by another item in the SAME bu_id', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1', name: 'Router', bu_id: 11 });
    repository.findBySkuInBu.mockResolvedValue({ id: 2, sku: 'SKU-2' });

    await expect(
      service.updateItem(fakeDb, 1, { sku: 'SKU-2', name: 'Router', unit: 'pcs' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ITEM_SKU_EXISTS' });
    expect(repository.findBySkuInBu).toHaveBeenCalledWith(fakeDb, 'SKU-2', 11);
  });

  it('searchItems delegates the query term to the repository', async () => {
    repository.search.mockResolvedValue([{ id: 1, sku: 'SKU-1', name: 'Router' }]);
    repository.countSearch.mockResolvedValue(1);

    const result = await service.searchItems(fakeDb, { q: 'router' });

    expect(repository.search).toHaveBeenCalledWith(fakeDb, 'router', { limit: 20, offset: 0, buIds: null });
    expect(result.data).toEqual([{ id: 1, sku: 'SKU-1', name: 'Router' }]);
  });

  it('listItemStocks throws 404 for an unknown item', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.listItemStocks(fakeDb, 999, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('listItemStocks passes the warehouse filter through to the repository', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1' });
    repository.findStocksByItem.mockResolvedValue([{ warehouse_id: 2, quantity: 5 }]);
    repository.countStocksByItem.mockResolvedValue(1);

    const result = await service.listItemStocks(fakeDb, 1, { warehouse_id: 2 });

    expect(repository.findStocksByItem).toHaveBeenCalledWith(fakeDb, 1, {
      warehouseId: 2,
      limit: 20,
      offset: 0
    });
    expect(result.data).toEqual([{ warehouse_id: 2, quantity: 5 }]);
  });

  it('getItemCost throws 404 for an unknown item', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.getItemCost(fakeDb, 999, { warehouse_id: 1 })).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it('getItemCost returns the repository cost summary', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1' });
    repository.costSummary.mockResolvedValue({
      item_id: 1,
      warehouse_id: 1,
      quantity_remaining: 10,
      total_value: '1000.00',
      average_unit_cost: '100.00'
    });

    const result = await service.getItemCost(fakeDb, 1, { warehouse_id: 1 });

    expect(repository.costSummary).toHaveBeenCalledWith(fakeDb, 1, 1);
    expect(result.data.average_unit_cost).toBe('100.00');
  });

  it('getItemCostHistory throws 404 for an unknown item', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.getItemCostHistory(fakeDb, 999, { warehouse_id: 1 })).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it('getItemCostHistory returns a paginated envelope', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1' });
    repository.findCostHistory.mockResolvedValue([{ id: 1, unit_cost: '100.00' }]);
    repository.countCostHistory.mockResolvedValue(1);

    const result = await service.getItemCostHistory(fakeDb, 1, { warehouse_id: 1 });

    expect(result).toEqual({
      data: [{ id: 1, unit_cost: '100.00' }],
      meta: { page: 1, per_page: 20, total: 1 }
    });
  });
});

// Regression coverage for the 2026-09-08 cross-tenant leak: items now carry
// their own bu_id and must be scoped like warehouses.
describe('items.service — bu_id scoping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('getItem rejects an item outside the caller\'s business units', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1', bu_id: 99 });

    await expect(service.getItem(fakeDb, 1, [11, 12])).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
  });

  it('getItem passes for an item inside the caller\'s business units', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1', bu_id: 11 });

    await expect(service.getItem(fakeDb, 1, [11, 12])).resolves.toEqual({
      data: { id: 1, sku: 'SKU-1', bu_id: 11 }
    });
  });

  it('getItem is unrestricted for super-admin (buIds null)', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1', bu_id: 99 });

    await expect(service.getItem(fakeDb, 1, null)).resolves.toMatchObject({
      data: { id: 1 }
    });
  });

  it('updateItem rejects an item outside the caller\'s business units before touching it', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1', bu_id: 99 });

    await expect(
      service.updateItem(fakeDb, 1, { sku: 'SKU-1', name: 'Router', unit: 'pcs' }, [11])
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.update).not.toHaveBeenCalled();
  });
});

// Barcode scanner support (2026-09-13) — POS lookup + uniqueness on create/update.
// Barcode uniqueness scoped per bu_id (2026-09-14 fix, same class as sku —
// see items.repository.js's findByBarcodeInBu/findByBarcodeInBuIds).
describe('items.service — barcode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('createItem allows a null/absent barcode (not every item has one yet)', async () => {
    repository.findBySkuInBu.mockResolvedValue(null);
    repository.create.mockResolvedValue({ id: 1, sku: 'SKU-1', barcode: null });

    await expect(service.createItem(fakeDb, { sku: 'SKU-1', name: 'Router', unit: 'pcs' })).resolves.toEqual({
      data: { id: 1, sku: 'SKU-1', barcode: null }
    });
    expect(repository.findByBarcodeInBu).not.toHaveBeenCalled();
  });

  it('createItem throws 409 ITEM_BARCODE_EXISTS when the barcode is already used in that bu_id', async () => {
    repository.findBySkuInBu.mockResolvedValue(null);
    repository.findByBarcodeInBu.mockResolvedValue({ id: 2, barcode: '899123456' });

    await expect(
      service.createItem(fakeDb, { sku: 'SKU-1', barcode: '899123456', name: 'Router', unit: 'pcs', bu_id: 11 })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ITEM_BARCODE_EXISTS' });
    expect(repository.findByBarcodeInBu).toHaveBeenCalledWith(fakeDb, '899123456', 11);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('createItem allows the SAME barcode across two DIFFERENT business units', async () => {
    repository.findBySkuInBu.mockResolvedValue(null);
    repository.findByBarcodeInBu.mockResolvedValue(null); // no match within bu_id 15
    repository.create.mockResolvedValue({ id: 3, barcode: '899123456', bu_id: 15 });

    await expect(
      service.createItem(fakeDb, { sku: 'SKU-2', barcode: '899123456', name: 'Barang lain', unit: 'pcs', bu_id: 15 })
    ).resolves.toBeDefined();
    expect(repository.findByBarcodeInBu).toHaveBeenCalledWith(fakeDb, '899123456', 15);
  });

  it('updateItem allows keeping the item\'s own unchanged barcode', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1', barcode: '899123456' });
    repository.update.mockResolvedValue({ id: 1, sku: 'SKU-1', barcode: '899123456' });

    await service.updateItem(fakeDb, 1, { sku: 'SKU-1', barcode: '899123456', name: 'Router', unit: 'pcs' });

    expect(repository.findByBarcodeInBu).not.toHaveBeenCalled();
  });

  it('updateItem throws 409 when reassigning to a barcode used by another item in the SAME bu_id', async () => {
    repository.findById.mockResolvedValue({ id: 1, sku: 'SKU-1', barcode: '111', bu_id: 11 });
    repository.findByBarcodeInBu.mockResolvedValue({ id: 2, barcode: '222' });

    await expect(
      service.updateItem(fakeDb, 1, { sku: 'SKU-1', barcode: '222', name: 'Router', unit: 'pcs' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ITEM_BARCODE_EXISTS' });
    expect(repository.findByBarcodeInBu).toHaveBeenCalledWith(fakeDb, '222', 11);
    expect(repository.update).not.toHaveBeenCalled();
  });

  describe('getItemByBarcode', () => {
    it('throws 404 when no item matches the scanned barcode within the caller\'s BUs', async () => {
      repository.findByBarcodeInBuIds.mockResolvedValue(null);

      await expect(service.getItemByBarcode(fakeDb, '000000', null, [11])).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND'
      });
      expect(repository.findByBarcodeInBuIds).toHaveBeenCalledWith(fakeDb, '000000', [11]);
    });

    it('returns just the item when no warehouse_id is given', async () => {
      repository.findByBarcodeInBuIds.mockResolvedValue({ id: 1, barcode: '899123456', bu_id: 11 });

      const result = await service.getItemByBarcode(fakeDb, '899123456', null, [11]);

      expect(result).toEqual({ data: { id: 1, barcode: '899123456', bu_id: 11 } });
      expect(stocksRepository.getQuantity).not.toHaveBeenCalled();
    });

    it('enriches the response with stock quantity when warehouse_id is given', async () => {
      repository.findByBarcodeInBuIds.mockResolvedValue({ id: 1, barcode: '899123456', bu_id: 11 });
      stocksRepository.getQuantity.mockResolvedValue(7);

      const result = await service.getItemByBarcode(fakeDb, '899123456', 3, [11]);

      expect(stocksRepository.getQuantity).toHaveBeenCalledWith(fakeDb, 3, 1);
      expect(result).toEqual({
        data: { id: 1, barcode: '899123456', bu_id: 11, stock: { warehouse_id: 3, quantity: 7 } }
      });
    });

    it('super-admin (buIds null) can look up a barcode across any BU', async () => {
      repository.findByBarcodeInBuIds.mockResolvedValue({ id: 1, barcode: '899123456', bu_id: 99 });

      const result = await service.getItemByBarcode(fakeDb, '899123456', null, null);

      expect(repository.findByBarcodeInBuIds).toHaveBeenCalledWith(fakeDb, '899123456', null);
      expect(result).toEqual({ data: { id: 1, barcode: '899123456', bu_id: 99 } });
    });
  });
});
