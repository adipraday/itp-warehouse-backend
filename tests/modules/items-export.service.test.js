import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/items/items.repository.js';
import * as warehousesRepository from '../../src/modules/warehouses/warehouses.repository.js';
import { buildImportTemplate, exportItems } from '../../src/modules/items/items-export.service.js';

vi.mock('../../src/modules/items/items.repository.js');
vi.mock('../../src/modules/warehouses/warehouses.repository.js');

const fakeDb = {};

describe('buildImportTemplate', () => {
  it('produces a header-only file matching the columns items-import.parser.js recognizes', async () => {
    const file = await buildImportTemplate('csv');

    expect(file.buffer.toString('utf8')).toBe(
      'sku,barcode,name,unit,min_stock,selling_price,warehouse_code,quantity,unit_cost\n'
    );
  });

  it('supports xlsx format too', async () => {
    const file = await buildImportTemplate('xlsx');

    expect(file.extension).toBe('xlsx');
  });
});

describe('exportItems', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('without warehouse_id: one row per item, master-data columns only (no quantity/unit_cost)', async () => {
    repository.findAll.mockResolvedValue([
      { id: 1, sku: 'SKU-1', barcode: null, name: 'Router', unit: 'pcs', min_stock: 5, selling_price: '150000.00' }
    ]);

    const file = await exportItems(fakeDb, { buIds: [13] });

    const text = file.buffer.toString('utf8');
    expect(text).toBe('sku,barcode,name,unit,min_stock,selling_price\nSKU-1,,Router,pcs,5,150000.00\n');
    expect(warehousesRepository.findById).not.toHaveBeenCalled();
  });

  it('passes buIds through to findAll (BU-scoped, unpaginated)', async () => {
    repository.findAll.mockResolvedValue([]);

    await exportItems(fakeDb, { buIds: [13] });

    expect(repository.findAll).toHaveBeenCalledWith(fakeDb, { limit: 100000, offset: 0, buIds: [13] });
  });

  it('with warehouse_id: includes warehouse_code and current_quantity, never quantity/unit_cost', async () => {
    warehousesRepository.findById.mockResolvedValue({ id: 1, code: 'WH-PUSAT' });
    repository.findAllWithStockAtWarehouse.mockResolvedValue([
      { id: 1, sku: 'SKU-1', barcode: '111', name: 'Router', unit: 'pcs', min_stock: 5, selling_price: '150000.00', quantity: 20 }
    ]);

    const file = await exportItems(fakeDb, { buIds: [13], warehouseId: 1 });

    const text = file.buffer.toString('utf8');
    expect(text).toBe(
      'sku,barcode,name,unit,min_stock,selling_price,warehouse_code,current_quantity\n' +
        'SKU-1,111,Router,pcs,5,150000.00,WH-PUSAT,20\n'
    );
    expect(text).not.toContain('unit_cost');
    expect(repository.findAllWithStockAtWarehouse).toHaveBeenCalledWith(fakeDb, 1, [13]);
  });

  it('an unedited per-warehouse export round-trips safely — the importer never recognizes "current_quantity"', async () => {
    // Documents the actual safety property: items-import.parser.js's required
    // headers (sku, name, unit) are present, but "current_quantity" is not
    // "quantity", so importing this file back verbatim adds NO new stock.
    warehousesRepository.findById.mockResolvedValue({ id: 1, code: 'WH-PUSAT' });
    repository.findAllWithStockAtWarehouse.mockResolvedValue([
      { id: 1, sku: 'SKU-1', barcode: null, name: 'Router', unit: 'pcs', min_stock: 5, selling_price: '150000.00', quantity: 20 }
    ]);

    const file = await exportItems(fakeDb, { buIds: [13], warehouseId: 1 });
    const headers = file.buffer.toString('utf8').split('\n')[0].split(',');

    expect(headers).not.toContain('quantity');
    expect(headers).not.toContain('unit_cost');
  });
});
