import * as repository from './items.repository.js';
import * as warehousesRepository from '../warehouses/warehouses.repository.js';
import { buildFileBuffer } from './items-export.file.js';

// Exactly the columns items-import.parser.js recognizes — a filled-in
// template is a valid import file with zero edits needed to the header row.
const TEMPLATE_HEADERS = ['sku', 'barcode', 'name', 'unit', 'min_stock', 'selling_price', 'warehouse_code', 'quantity', 'unit_cost'];

// Deliberately WITHOUT `quantity`/`unit_cost` — see items-export.service.js's
// exportItems() comment below for why re-importing an unedited export must
// never silently double stock.
const EXPORT_HEADERS_ALL_WAREHOUSES = ['sku', 'barcode', 'name', 'unit', 'min_stock', 'selling_price'];
const EXPORT_HEADERS_ONE_WAREHOUSE = [...EXPORT_HEADERS_ALL_WAREHOUSES, 'warehouse_code', 'current_quantity'];

export async function buildImportTemplate(format = 'csv') {
  return buildFileBuffer(format, TEMPLATE_HEADERS, []);
}

function toRow(item) {
  return {
    sku: item.sku,
    barcode: item.barcode ?? '',
    name: item.name,
    unit: item.unit,
    min_stock: item.min_stock,
    selling_price: item.selling_price
  };
}

// Export is for bulk-editing MASTER DATA and re-importing safely — NOT for
// round-tripping stock. That's why the export never uses the column names
// `quantity`/`unit_cost` that items-import.service.js actually acts on:
// re-uploading an unedited export would otherwise silently create ANOTHER
// inbound for whatever quantity was exported, double-counting stock. Current
// stock is still shown (as `current_quantity`, informational only) when a
// single warehouse is requested — the importer simply doesn't recognize that
// column name, so it's inert on re-import.
export async function exportItems(db, { buIds, warehouseId = null, format = 'csv' }) {
  if (warehouseId) {
    const [warehouse, items] = await Promise.all([
      warehousesRepository.findById(db, warehouseId),
      repository.findAllWithStockAtWarehouse(db, warehouseId, buIds)
    ]);
    const rows = items.map((item) => ({
      ...toRow(item),
      warehouse_code: warehouse?.code ?? '',
      current_quantity: item.quantity
    }));
    return buildFileBuffer(format, EXPORT_HEADERS_ONE_WAREHOUSE, rows);
  }

  // No pagination — an export is meant to capture everything in one file.
  const items = await repository.findAll(db, { limit: 100000, offset: 0, buIds });
  return buildFileBuffer(format, EXPORT_HEADERS_ALL_WAREHOUSES, items.map(toRow));
}
