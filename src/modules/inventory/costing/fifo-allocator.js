import { ConflictError } from '../../../shared/errors/app-error.js';
import * as costLayersRepository from './cost-layers.repository.js';

// Locks available FIFO layers oldest-first and allocates quantityNeeded across
// as many as required. Shared by every stock-out path (outbound, transfer,
// opname shortage) since the consumption algorithm itself never varies.
export async function allocateFifo(connection, { warehouseId, itemId, quantityNeeded }) {
  const layers = await costLayersRepository.lockAvailableLayers(connection, warehouseId, itemId);

  let remaining = quantityNeeded;
  const allocations = [];
  for (const layer of layers) {
    if (remaining <= 0) break;
    const take = Math.min(layer.quantity_remaining, remaining);
    allocations.push({ costLayerId: layer.id, quantity: take, unitCost: layer.unit_cost });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new ConflictError('INSUFFICIENT_STOCK', `Insufficient FIFO cost layer quantity for item ${itemId}`);
  }

  return allocations;
}
