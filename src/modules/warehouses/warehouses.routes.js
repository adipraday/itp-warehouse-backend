import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './warehouses.service.js';
import {
  listWarehousesSchema,
  getWarehouseSchema,
  createWarehouseSchema,
  updateWarehouseSchema,
  deleteWarehouseSchema,
  listWarehouseStocksSchema,
  warehouseStockSummarySchema,
  provisionDefaultWarehouseSchema
} from './warehouses.schema.js';

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  return error;
}

// super-admin (buIds null) may set/keep any bu_id. A scoped caller (buIds is an
// array — home BU + any admin-bu grants) may explicitly pick any ONE of their
// own allowed BUs (e.g. create a warehouse in a BU they were granted, not just
// their home one) — but never a bu_id outside that set; falls back to their
// home BU if none was given or the one given isn't theirs to use.
function effectiveBuId(request) {
  const ctx = request.userContext;
  if (!ctx || ctx.buIds == null) {
    return request.body?.bu_id ?? null;
  }
  const requested = request.body?.bu_id;
  if (requested != null && ctx.buIds.map(Number).includes(Number(requested))) {
    return Number(requested);
  }
  return ctx.buId;
}

const write = { onRequest: guard('warehouses', 'write') };
const scopedWrite = { onRequest: guard('warehouses', 'write'), preValidation: buScope('warehouses') };
const scopedRead = { preValidation: buScope('warehouses') };

export async function warehousesRoutes(app) {
  app.get('/', { schema: listWarehousesSchema }, async (request) => {
    return service.listWarehouses(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...scopedRead, schema: getWarehouseSchema }, async (request) => {
    return service.getWarehouse(app.db, request.params.id);
  });

  // Auto-provisioning (2026-09-08): "ensure this BU has a main warehouse" —
  // idempotent, meant to be called right after a BU/company is created.
  app.post('/provision-default', { ...write, schema: provisionDefaultWarehouseSchema }, async (request, reply) => {
    const ctx = request.userContext;
    const buId = request.body.bu_id;
    if (ctx?.buIds != null && !ctx.buIds.map(Number).includes(Number(buId))) {
      throw forbidden(`business unit ${buId} is outside your business unit`);
    }

    const result = await service.provisionDefaultWarehouse(app.db, buId, ctx?.userId, app.config);
    reply.status(result.created ? 201 : 200);
    return { data: result.data };
  });

  app.post('/', { ...write, schema: createWarehouseSchema }, async (request, reply) => {
    const result = await service.createWarehouse(
      app.db,
      { ...request.body, bu_id: effectiveBuId(request) },
      request.userContext?.userId,
      app.config
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...scopedWrite, schema: updateWarehouseSchema }, async (request) => {
    return service.updateWarehouse(
      app.db,
      request.params.id,
      { ...request.body, bu_id: effectiveBuId(request) },
      app.config
    );
  });

  app.delete('/:id', { ...scopedWrite, schema: deleteWarehouseSchema }, async (request) => {
    return service.deleteWarehouse(app.db, request.params.id);
  });

  app.get('/:id/stocks', { ...scopedRead, schema: listWarehouseStocksSchema }, async (request) => {
    return service.listWarehouseStocks(app.db, request.params.id, request.query);
  });

  app.get('/:id/stock-summary', { ...scopedRead, schema: warehouseStockSummarySchema }, async (request) => {
    return service.getWarehouseStockSummary(app.db, request.params.id);
  });
}
