import * as stocksRepository from '../../modules/inventory/stocks/stocks.repository.js';
import * as itemsRepository from '../../modules/items/items.repository.js';
import * as warehousesRepository from '../../modules/warehouses/warehouses.repository.js';
import { notifyStakeholders } from './push.js';

// Called after a stock-decreasing operation's transaction has already
// COMMITTED (never from inside the transaction itself — a push-notification
// network call must not hold a row lock open) — checks each touched
// (warehouseId, itemId) pair's current quantity against the item's
// min_stock and notifies purchasing/admin-bu if at/under threshold.
//
// Known limitation (accepted for v1): this fires on every decrement that
// lands at-or-below the threshold, not just the first crossing into it — an
// item that stays low across several more completions notifies again each
// time rather than once. Revisit (e.g. a per-item "last notified at" to
// suppress repeats) if this turns out noisy in practice.
export async function checkLowStock(pool, warehouseItemPairs) {
  for (const { warehouseId, itemId } of warehouseItemPairs) {
    try {
      const [quantity, item, warehouse] = await Promise.all([
        stocksRepository.getQuantity(pool, warehouseId, itemId),
        itemsRepository.findById(pool, itemId),
        warehousesRepository.findById(pool, warehouseId)
      ]);
      if (!item || !warehouse || warehouse.bu_id == null) continue;

      const qty = Number(quantity);
      const minStock = Number(item.min_stock ?? 0);
      const isOut = qty <= 0;
      const isLow = !isOut && minStock > 0 && qty <= minStock;
      if (!isOut && !isLow) continue;

      const title = isOut ? 'Stok Habis' : 'Stok Menipis';
      const body = isOut
        ? `${item.name} (${item.sku}) di ${warehouse.name} sudah habis.`
        : `${item.name} (${item.sku}) di ${warehouse.name} tersisa ${qty} (min. ${minStock}).`;
      const data = { type: isOut ? 'out_of_stock' : 'low_stock', item_id: itemId, warehouse_id: warehouseId };

      await notifyStakeholders(pool, {
        buId: warehouse.bu_id,
        extraBuRoles: ['purchasing'],
        includeOwner: true,
        warehouseId,
        warehouseRoles: ['admin-warehouse'],
        title,
        body,
        data
      });
    } catch (error) {
      console.warn('[push] checkLowStock failed', { warehouseId, itemId, error: error.message });
    }
  }
}
