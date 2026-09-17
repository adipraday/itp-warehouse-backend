import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/items/items.repository.js';
import * as warehousesRepository from '../../src/modules/warehouses/warehouses.repository.js';
import * as inboundsRepository from '../../src/modules/inventory/inbounds/inbounds.repository.js';
import * as stocksRepository from '../../src/modules/inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../../src/modules/inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../../src/modules/inventory/costing/cost-layers.repository.js';
import { importItems } from '../../src/modules/items/items-import.service.js';

vi.mock('../../src/modules/items/items.repository.js');
vi.mock('../../src/modules/warehouses/warehouses.repository.js');
vi.mock('../../src/modules/inventory/inbounds/inbounds.repository.js');
vi.mock('../../src/modules/inventory/stocks/stocks.repository.js');
vi.mock('../../src/modules/inventory/stock-mutations/stock-mutations.repository.js');
vi.mock('../../src/modules/inventory/costing/cost-layers.repository.js');
vi.mock('../../src/shared/database/transaction.js', () => ({
  withTransaction: vi.fn((pool, work) => work({}))
}));

const fakePool = {};
const BU_ID = 13;

function csvFile(text, filename = 'items.csv') {
  return { buffer: Buffer.from(text, 'utf8'), filename, mimetype: 'text/csv' };
}

describe('importItems', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repository.findByBarcodeInBu.mockResolvedValue(null);
    repository.findBySkuInBu.mockResolvedValue(null);
  });

  it('throws BU_REQUIRED when the caller has no home business unit', async () => {
    await expect(
      importItems(fakePool, csvFile('sku,name,unit\nSKU-1,Router,pcs\n'), { userId: 1, buId: null })
    ).rejects.toMatchObject({ statusCode: 400, code: 'BU_REQUIRED' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects the whole file (no writes at all) when any row fails validation', async () => {
    const file = csvFile('sku,name,unit\nSKU-1,Router,pcs\n,Missing SKU,pcs\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).rejects.toMatchObject({
      statusCode: 400,
      code: 'IMPORT_VALIDATION_FAILED',
      details: [{ row: 3, message: 'sku is required' }]
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects a duplicate sku within the same file', async () => {
    const file = csvFile('sku,name,unit\nSKU-1,Router,pcs\nSKU-1,Router lagi,pcs\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).rejects.toMatchObject({
      code: 'IMPORT_VALIDATION_FAILED',
      details: [{ row: 3, message: 'duplicate sku "SKU-1" — each sku may appear at most once per import' }]
    });
  });

  it('rejects quantity given without a warehouse_code', async () => {
    const file = csvFile('sku,name,unit,quantity\nSKU-1,Router,pcs,10\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).rejects.toMatchObject({
      details: [{ row: 2, message: 'quantity given without a warehouse_code' }]
    });
  });

  it('rejects an unknown warehouse_code', async () => {
    warehousesRepository.findByCode.mockResolvedValue(null);
    const file = csvFile('sku,name,unit,warehouse_code,quantity,unit_cost\nSKU-1,Router,pcs,WH-X,10,50000\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).rejects.toMatchObject({
      details: [{ row: 2, message: 'warehouse_code "WH-X" not found' }]
    });
  });

  it('rejects a warehouse_code belonging to a DIFFERENT business unit', async () => {
    warehousesRepository.findByCode.mockResolvedValue({ id: 5, code: 'WH-X', bu_id: 99 });
    const file = csvFile('sku,name,unit,warehouse_code,quantity,unit_cost\nSKU-1,Router,pcs,WH-X,10,50000\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).rejects.toMatchObject({
      details: [{ row: 2, message: 'warehouse_code "WH-X" does not belong to your business unit' }]
    });
  });

  it('requires unit_cost when quantity > 0', async () => {
    warehousesRepository.findByCode.mockResolvedValue({ id: 5, code: 'WH-X', bu_id: BU_ID });
    const file = csvFile('sku,name,unit,warehouse_code,quantity\nSKU-1,Router,pcs,WH-X,10\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).rejects.toMatchObject({
      details: [{ row: 2, message: 'unit_cost is required and must be a non-negative number when quantity > 0' }]
    });
  });

  it('rejects a barcode already assigned to a different item', async () => {
    repository.findByBarcodeInBu.mockResolvedValue({ id: 999, barcode: '111' });
    const file = csvFile('sku,barcode,name,unit\nSKU-1,111,Router,pcs\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).rejects.toMatchObject({
      details: [{ row: 2, message: 'barcode "111" is already assigned to another item in this business unit' }]
    });
  });

  it('allows a barcode that already belongs to the SAME item being updated', async () => {
    repository.findByBarcodeInBu.mockResolvedValue({ id: 42, barcode: '111' });
    repository.findBySkuInBu.mockResolvedValue({ id: 42, sku: 'SKU-1' });
    repository.update.mockResolvedValue({ id: 42 });
    const file = csvFile('sku,barcode,name,unit\nSKU-1,111,Router,pcs\n');

    await expect(importItems(fakePool, file, { userId: 1, buId: BU_ID })).resolves.toBeDefined();
  });

  it('creates new items and skips stock injection when no warehouse_code is given', async () => {
    repository.create.mockResolvedValue({ id: 1 });
    const file = csvFile('sku,name,unit\nSKU-1,Router,pcs\nSKU-2,Switch,pcs\n');

    const result = await importItems(fakePool, file, { userId: 7, buId: BU_ID });

    expect(repository.create).toHaveBeenCalledTimes(2);
    expect(repository.create).toHaveBeenCalledWith(
      {},
      { sku: 'SKU-1', barcode: null, name: 'Router', unit: 'pcs', min_stock: 0, selling_price: 0, bu_id: BU_ID },
      7
    );
    expect(inboundsRepository.insertHeader).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ items_created: 2, items_updated: 0, warehouses_stocked: 0, rows_processed: 2 });
  });

  it('updates an existing item (matched by sku within the caller\'s bu_id) instead of creating a duplicate', async () => {
    repository.findBySkuInBu.mockResolvedValue({ id: 10, sku: 'SKU-1' });
    repository.update.mockResolvedValue({ id: 10 });
    const file = csvFile('sku,name,unit\nSKU-1,Router Baru,pcs\n');

    const result = await importItems(fakePool, file, { userId: 1, buId: BU_ID });

    expect(repository.update).toHaveBeenCalledWith(
      {},
      10,
      { sku: 'SKU-1', barcode: null, name: 'Router Baru', unit: 'pcs', min_stock: 0, selling_price: 0, bu_id: BU_ID }
    );
    expect(repository.create).not.toHaveBeenCalled();
    expect(result.data.items_updated).toBe(1);
  });

  it('creates one completed inbound per warehouse and posts stock/cost-layer/mutation for each line', async () => {
    warehousesRepository.findByCode.mockResolvedValue({ id: 5, code: 'WH-PUSAT', bu_id: BU_ID });
    repository.create.mockResolvedValueOnce({ id: 101 }).mockResolvedValueOnce({ id: 102 });
    inboundsRepository.insertHeader.mockResolvedValue(500);
    stockMutationsRepository.create.mockResolvedValue(900);

    const file = csvFile(
      'sku,name,unit,warehouse_code,quantity,unit_cost\n' +
        'SKU-1,Router,pcs,WH-PUSAT,10,50000\n' +
        'SKU-2,Switch,pcs,WH-PUSAT,5,30000\n'
    );

    const result = await importItems(fakePool, file, { userId: 7, buId: BU_ID });

    expect(inboundsRepository.insertHeader).toHaveBeenCalledTimes(1); // one warehouse -> one document
    expect(inboundsRepository.insertDetails).toHaveBeenCalledWith(
      {},
      500,
      [
        { item_id: 101, quantity: 10, unit_price: 50000 },
        { item_id: 102, quantity: 5, unit_price: 30000 }
      ]
    );
    expect(stocksRepository.ensureRow).toHaveBeenCalledWith({}, 5, 101);
    expect(stockMutationsRepository.create).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ warehouse_id: 5, item_id: 101, quantity: 10, source_type: 'INVENTORY_TRANSACTION', inventory_transaction_id: 500 })
    );
    expect(costLayersRepository.create).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ warehouse_id: 5, item_id: 101, unit_cost: 50000, quantity_received: 10 })
    );
    expect(stocksRepository.increment).toHaveBeenCalledWith({}, 5, 101, 10);
    expect(inboundsRepository.markCompleted).toHaveBeenCalledWith({}, 500, 7);
    expect(result.data).toMatchObject({ items_created: 2, warehouses_stocked: 1, inbound_ids: [500] });
  });

  it('groups rows across two different warehouses into two separate inbound documents', async () => {
    warehousesRepository.findByCode.mockImplementation(async (db, code) =>
      code === 'WH-PUSAT' ? { id: 1, code: 'WH-PUSAT', bu_id: BU_ID } : { id: 2, code: 'WH-CABANG', bu_id: BU_ID }
    );
    repository.create.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 });
    inboundsRepository.insertHeader.mockResolvedValueOnce(500).mockResolvedValueOnce(501);
    stockMutationsRepository.create.mockResolvedValue(1);

    const file = csvFile(
      'sku,name,unit,warehouse_code,quantity,unit_cost\n' +
        'SKU-1,Router,pcs,WH-PUSAT,10,50000\n' +
        'SKU-2,Switch,pcs,WH-CABANG,5,30000\n'
    );

    const result = await importItems(fakePool, file, { userId: 1, buId: BU_ID });

    expect(inboundsRepository.insertHeader).toHaveBeenCalledTimes(2);
    expect(result.data.warehouses_stocked).toBe(2);
    expect(result.data.inbound_ids).toEqual([500, 501]);
  });
});
