import { BadRequestError } from '../../shared/errors/app-error.js';
import { withTransaction } from '../../shared/database/transaction.js';
import * as repository from './items.repository.js';
import * as warehousesRepository from '../warehouses/warehouses.repository.js';
import * as inboundsRepository from '../inventory/inbounds/inbounds.repository.js';
import * as stocksRepository from '../inventory/stocks/stocks.repository.js';
import * as stockMutationsRepository from '../inventory/stock-mutations/stock-mutations.repository.js';
import * as costLayersRepository from '../inventory/costing/cost-layers.repository.js';
import { parseImportFile } from './items-import.parser.js';

// null/undefined/'' -> null ("not given"); anything else -> Number(...), which
// is NaN for genuine garbage input ("abc") so the caller can tell "absent"
// (defaults apply) apart from "present but invalid" (must be rejected).
function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number(value);
}

// Read-only validation pass — every DB call here is a plain read, so a file
// that fails validation never has a chance to write anything (2026-09-14
// decision: reject the whole import if ANY row is wrong, nothing partial).
async function validateRows(db, rawRows, buId) {
  const errors = [];
  const normalizedRows = [];
  const warehouseCache = new Map();
  const skusSeen = new Set();

  for (const [index, raw] of rawRows.entries()) {
    const rowNumber = index + 2; // +1 for 0-index, +1 for the header row itself
    const fail = (message) => errors.push({ row: rowNumber, message });

    const sku = String(raw.sku ?? '').trim();
    const name = String(raw.name ?? '').trim();
    const unit = String(raw.unit ?? '').trim();
    const barcode = raw.barcode != null && String(raw.barcode).trim() !== '' ? String(raw.barcode).trim() : null;
    const warehouseCode = raw.warehouse_code != null ? String(raw.warehouse_code).trim() : '';

    if (!sku) fail('sku is required');
    if (!name) fail('name is required');
    if (!unit) fail('unit is required');

    // One row per SKU only (2026-09-14 scope decision) — a business that
    // wants the same item stocked at two warehouses runs two import files,
    // or stocks the second warehouse via the normal /api/inbounds flow.
    // Merging multiple rows per SKU is a real feature but adds enough
    // ambiguity (which row's name/unit/etc. wins?) to be its own follow-up.
    if (sku) {
      if (skusSeen.has(sku)) fail(`duplicate sku "${sku}" — each sku may appear at most once per import`);
      skusSeen.add(sku);
    }

    const minStock = parseOptionalNumber(raw.min_stock) ?? 0;
    if (Number.isNaN(minStock) || minStock < 0) fail('min_stock must be a non-negative number');

    const sellingPrice = parseOptionalNumber(raw.selling_price) ?? 0;
    if (Number.isNaN(sellingPrice) || sellingPrice < 0) fail('selling_price must be a non-negative number');

    let warehouseId = null;
    const quantity = parseOptionalNumber(raw.quantity) ?? 0;
    const unitCost = parseOptionalNumber(raw.unit_cost);

    if (warehouseCode) {
      if (!warehouseCache.has(warehouseCode)) {
        warehouseCache.set(warehouseCode, await warehousesRepository.findByCode(db, warehouseCode));
      }
      const warehouse = warehouseCache.get(warehouseCode);
      if (!warehouse) {
        fail(`warehouse_code "${warehouseCode}" not found`);
      } else if (Number(warehouse.bu_id) !== Number(buId)) {
        fail(`warehouse_code "${warehouseCode}" does not belong to your business unit`);
      } else {
        warehouseId = warehouse.id;
      }

      if (Number.isNaN(quantity) || quantity < 0) fail('quantity must be a non-negative number');
      if (quantity > 0 && (unitCost == null || Number.isNaN(unitCost) || unitCost < 0)) {
        fail('unit_cost is required and must be a non-negative number when quantity > 0');
      }
    } else if (raw.quantity != null && String(raw.quantity).trim() !== '') {
      fail('quantity given without a warehouse_code');
    }

    if (barcode) {
      // Scoped per bu_id (2026-09-14 fix) — same reasoning as findBySkuInBu.
      const barcodeOwner = await repository.findByBarcodeInBu(db, barcode, buId);
      const existingItem = sku ? await repository.findBySkuInBu(db, sku, buId) : null;
      if (barcodeOwner && (!existingItem || Number(barcodeOwner.id) !== Number(existingItem.id))) {
        fail(`barcode "${barcode}" is already assigned to another item in this business unit`);
      }
    }

    normalizedRows.push({
      row: rowNumber,
      sku,
      barcode,
      name,
      unit,
      min_stock: minStock,
      selling_price: sellingPrice,
      warehouse_id: warehouseId,
      quantity: warehouseId ? quantity : 0,
      unit_cost: unitCost ?? 0
    });
  }

  return { errors, normalizedRows };
}

// Bulk item + initial-stock import (2026-09-14). Confirmed design: CSV and
// .xlsx both supported, an existing sku (within the caller's own bu_id — see
// the 202609140001 migration fixing sku uniqueness to be per-BU) is updated
// rather than rejected, and ANY row failing validation rejects the entire
// file — nothing is written unless everything checks out.
//
// Stock is deliberately injected via a real, already-COMPLETED inbound
// document (one per warehouse touched) rather than writing stocks/cost-layer
// rows by hand — that's the exact same mechanism inbounds.service.js's
// completeInbound() uses, so FIFO valuation stays correct and the import
// shows up in the ordinary /api/inbounds history as "how did this stock get
// here" instead of an unexplained quantity jump.
export async function importItems(pool, file, { userId = null, buId = null }) {
  if (buId == null) {
    throw new BadRequestError(
      'BU_REQUIRED',
      'Item import requires a caller with a home business unit (admin-bu/purchasing) — super-admin must use the regular per-item endpoints'
    );
  }

  const rawRows = await parseImportFile(file.buffer, { filename: file.filename, mimetype: file.mimetype });
  const { errors, normalizedRows } = await validateRows(pool, rawRows, buId);

  if (errors.length > 0) {
    throw new BadRequestError(
      'IMPORT_VALIDATION_FAILED',
      `${errors.length} row(s) failed validation — nothing was imported`,
      errors
    );
  }

  const result = await withTransaction(pool, async (connection) => {
    const itemIdBySku = new Map();
    let itemsCreated = 0;
    let itemsUpdated = 0;

    for (const row of normalizedRows) {
      const existing = await repository.findBySkuInBu(connection, row.sku, buId);
      const payload = {
        sku: row.sku,
        barcode: row.barcode,
        name: row.name,
        unit: row.unit,
        min_stock: row.min_stock,
        selling_price: row.selling_price,
        bu_id: buId
      };

      if (existing) {
        await repository.update(connection, existing.id, payload);
        itemIdBySku.set(row.sku, existing.id);
        itemsUpdated += 1;
      } else {
        const created = await repository.create(connection, payload, userId);
        itemIdBySku.set(row.sku, created.id);
        itemsCreated += 1;
      }
    }

    // One inbound document per warehouse touched, not per row — a business
    // stocking 50 items into one warehouse gets one inbound with 50 lines,
    // not 50 separate documents.
    const detailsByWarehouse = new Map();
    for (const row of normalizedRows) {
      if (!row.warehouse_id || row.quantity <= 0) continue;
      if (!detailsByWarehouse.has(row.warehouse_id)) detailsByWarehouse.set(row.warehouse_id, []);
      detailsByWarehouse.get(row.warehouse_id).push({
        item_id: itemIdBySku.get(row.sku),
        quantity: row.quantity,
        unit_price: row.unit_cost
      });
    }

    const inboundIds = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const [warehouseId, details] of detailsByWarehouse) {
      const transactionId = await inboundsRepository.insertHeader(
        connection,
        { warehouse_id: warehouseId, contact_id: null, transaction_date: today, notes: 'Initial stock from item import' },
        userId
      );
      await inboundsRepository.insertDetails(connection, transactionId, details);

      for (const detail of details) {
        await stocksRepository.ensureRow(connection, warehouseId, detail.item_id);
        await stocksRepository.lockRow(connection, warehouseId, detail.item_id);

        const totalCost = (detail.quantity * Number(detail.unit_price)).toFixed(2);
        const mutationId = await stockMutationsRepository.create(connection, {
          warehouse_id: warehouseId,
          item_id: detail.item_id,
          type: 'IN',
          direction: 'IN',
          quantity: detail.quantity,
          total_cost: totalCost,
          source_type: 'INVENTORY_TRANSACTION',
          source_id: transactionId,
          inventory_transaction_id: transactionId
        });
        await costLayersRepository.create(connection, {
          warehouse_id: warehouseId,
          item_id: detail.item_id,
          source_stock_mutation_id: mutationId,
          quantity_received: detail.quantity,
          quantity_remaining: detail.quantity,
          unit_cost: detail.unit_price
        });
        await stocksRepository.increment(connection, warehouseId, detail.item_id, detail.quantity);
      }

      await inboundsRepository.markCompleted(connection, transactionId, userId);
      inboundIds.push(transactionId);
    }

    return {
      rows_processed: normalizedRows.length,
      items_created: itemsCreated,
      items_updated: itemsUpdated,
      warehouses_stocked: detailsByWarehouse.size,
      inbound_ids: inboundIds
    };
  });

  return { data: result };
}
