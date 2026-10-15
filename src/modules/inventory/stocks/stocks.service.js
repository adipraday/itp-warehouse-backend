import { parsePagination } from '../../../shared/utils/pagination.js';
import * as repository from './stocks.repository.js';
import { buildFileBuffer } from '../../items/items-export.file.js';
import { buildPdfTable } from '../../../shared/export/pdf-table.js';
import * as warehousesRepository from '../../warehouses/warehouses.repository.js';

export async function listStocks(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const filter = {
    warehouseId: query.warehouse_id ?? null,
    itemId: query.item_id ?? null,
    q: q || null,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function listLowStock(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const warehouseId = query.warehouse_id ?? null;
  const [data, total] = await Promise.all([
    repository.findLowStock(db, { warehouseId, buIds, assignedWarehouseIds, limit: per_page, offset }),
    repository.countLowStock(db, { warehouseId, buIds, assignedWarehouseIds })
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function listOutOfStock(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const warehouseId = query.warehouse_id ?? null;
  const [data, total] = await Promise.all([
    repository.findOutOfStock(db, { warehouseId, buIds, assignedWarehouseIds, limit: per_page, offset }),
    repository.countOutOfStock(db, { warehouseId, buIds, assignedWarehouseIds })
  ]);
  return { data, meta: { page, per_page, total } };
}

const EXPORT_HEADERS = ['warehouse_code', 'warehouse_name', 'sku', 'item_name', 'unit', 'quantity', 'min_stock', 'status'];

export function stockStatusLabel({ quantity, min_stock }) {
  if (Number(quantity) <= 0) return 'Out of Stock';
  if (Number(quantity) <= Number(min_stock)) return 'Low Stock';
  return 'Normal';
}

export async function exportStocks(db, { status = 'all', warehouseId = null, format = 'csv', buIds = null, assignedWarehouseIds = null }) {
  const rows = await repository.findAllForExport(db, { status, warehouseId, buIds, assignedWarehouseIds });
  const data = rows.map((row) => ({
    warehouse_code: row.warehouse_code,
    warehouse_name: row.warehouse_name,
    sku: row.sku,
    item_name: row.item_name,
    unit: row.unit,
    quantity: row.quantity,
    min_stock: row.min_stock,
    status: stockStatusLabel(row)
  }));
  if (format === 'pdf') {
    return {
      buffer: await buildStockPdf(db, { data, status, warehouseId }),
      contentType: 'application/pdf',
      extension: 'pdf'
    };
  }
  return buildFileBuffer(format, EXPORT_HEADERS, data, 'Stok');
}

const STATUS_FILTER_LABELS = { all: 'Semua stok', low: 'Low Stock', out: 'Out of Stock' };
const STATUS_COLORS = { 'Low Stock': '#B26A00', 'Out of Stock': '#C62828' };

async function buildStockPdf(db, { data, status, warehouseId }) {
  const warehouse = warehouseId ? await warehousesRepository.findById(db, warehouseId) : null;
  const generatedAt = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date());
  return buildPdfTable({
    title: 'Laporan Stok',
    subtitleLines: [
      `Filter: ${STATUS_FILTER_LABELS[status] ?? STATUS_FILTER_LABELS.all}`,
      `Warehouse: ${warehouse ? `${warehouse.code} - ${warehouse.name}` : 'Semua warehouse'}`,
      `Dicetak: ${generatedAt} WIB  |  Total baris: ${data.length}`
    ],
    columns: [
      { key: 'warehouse_code', label: 'Warehouse', width: 1.2 },
      { key: 'sku', label: 'SKU', width: 1.4 },
      { key: 'item_name', label: 'Nama Item', width: 3.4 },
      { key: 'unit', label: 'Satuan', width: 0.9 },
      { key: 'quantity', label: 'Qty', width: 0.9, align: 'right' },
      { key: 'min_stock', label: 'Min', width: 0.9, align: 'right' },
      { key: 'status', label: 'Status', width: 1.3, color: (row) => STATUS_COLORS[row.status] }
    ],
    rows: data
  });
}
