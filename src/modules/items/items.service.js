import { NotFoundError, ConflictError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { assertRowInScope } from '../../shared/auth/master-data-scope.js';
import * as repository from './items.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';

export async function listItems(db, query, buIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const [data, total] = await Promise.all([
    repository.findAll(db, { limit: per_page, offset, buIds }),
    repository.count(db, buIds)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getItem(db, id, buIds = null) {
  const item = await repository.findById(db, id);
  if (!item) throw new NotFoundError(`Item ${id} not found`);
  assertRowInScope(item, buIds, 'item');
  return { data: item };
}

// Scoped per bu_id (2026-09-14 fix — same class of bug as sku, found via a
// real user report: two unrelated shops both legitimately stocking the same
// manufactured product, e.g. the same cigarette pack's EAN, "8994796151294")
// — a barcode identifies the PRODUCT, not who's allowed to sell it, so global
// uniqueness was wrong the same way it was wrong for sku.
async function assertBarcodeAvailable(db, barcode, buId, excludeId = null) {
  if (!barcode) return; // barcode is optional — not every item has one yet
  const duplicate = await repository.findByBarcodeInBu(db, barcode, buId);
  if (duplicate && Number(duplicate.id) !== Number(excludeId)) {
    throw new ConflictError(
      'ITEM_BARCODE_EXISTS',
      `Barcode "${barcode}" is already assigned to another item in this business unit`
    );
  }
}

export async function createItem(db, payload, userId = null) {
  const buId = payload.bu_id ?? null;
  const duplicate = await repository.findBySkuInBu(db, payload.sku, buId);
  if (duplicate) {
    throw new ConflictError('ITEM_SKU_EXISTS', `Item SKU "${payload.sku}" already exists in this business unit`);
  }
  await assertBarcodeAvailable(db, payload.barcode, buId);

  const item = await repository.create(db, payload, userId);
  return { data: item };
}

export async function updateItem(db, id, payload, buIds = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Item ${id} not found`);
  assertRowInScope(existing, buIds, 'item');

  const buId = payload.bu_id ?? existing.bu_id;
  if (payload.sku !== existing.sku) {
    const duplicate = await repository.findBySkuInBu(db, payload.sku, buId);
    if (duplicate) {
      throw new ConflictError('ITEM_SKU_EXISTS', `Item SKU "${payload.sku}" already exists in this business unit`);
    }
  }
  if (payload.barcode !== existing.barcode) {
    await assertBarcodeAvailable(db, payload.barcode, buId, id);
  }

  const item = await repository.update(db, id, payload);
  return { data: item };
}

// The core POS lookup: scan -> exact-match resolve. Optionally enriched with
// the item's stock quantity at one warehouse (the cashier's own), so the POS
// screen doesn't need a second round trip per scan. Scoped to the caller's
// accessible BUs directly in the query (findByBarcodeInBuIds) — necessary
// now that barcode is only unique PER bu_id (2026-09-14 fix), so an unscoped
// lookup could otherwise return a completely different business's item.
export async function getItemByBarcode(db, barcode, warehouseId, buIds = null) {
  const item = await repository.findByBarcodeInBuIds(db, barcode, buIds);
  if (!item) throw new NotFoundError(`No item found for barcode "${barcode}"`);

  if (!warehouseId) return { data: item };

  const quantity = await stocksRepository.getQuantity(db, warehouseId, item.id);
  return { data: { ...item, stock: { warehouse_id: Number(warehouseId), quantity } } };
}

export async function searchItems(db, query, buIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const [data, total] = await Promise.all([
    repository.search(db, query.q, { limit: per_page, offset, buIds }),
    repository.countSearch(db, query.q, buIds)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function listItemStocks(db, id, query, buIds = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Item ${id} not found`);
  assertRowInScope(existing, buIds, 'item');

  const { page, per_page, offset } = parsePagination(query);
  const warehouseId = query.warehouse_id ?? null;
  const [data, total] = await Promise.all([
    repository.findStocksByItem(db, id, { warehouseId, limit: per_page, offset }),
    repository.countStocksByItem(db, id, warehouseId)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getItemCost(db, id, query, buIds = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Item ${id} not found`);
  assertRowInScope(existing, buIds, 'item');

  const summary = await repository.costSummary(db, id, query.warehouse_id);
  return { data: summary };
}

export async function getItemCostHistory(db, id, query, buIds = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Item ${id} not found`);
  assertRowInScope(existing, buIds, 'item');

  const { page, per_page, offset } = parsePagination(query);
  const [data, total] = await Promise.all([
    repository.findCostHistory(db, id, query.warehouse_id, { limit: per_page, offset }),
    repository.countCostHistory(db, id, query.warehouse_id)
  ]);
  return { data, meta: { page, per_page, total } };
}
