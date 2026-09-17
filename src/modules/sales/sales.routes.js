import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './sales.service.js';
import {
  listSalesSchema,
  getSaleSchema,
  createSaleSchema,
  updateSaleSchema,
  deleteSaleSchema,
  getSaleReceiptSchema,
  holdSaleSchema,
  resumeSaleSchema,
  completeSaleSchema,
  cancelSaleSchema
} from './sales.schema.js';

const scope = buScope('sales');
const write = { onRequest: guard('sales', 'write'), preValidation: scope };
const read = { preValidation: scope };

export async function salesRoutes(app) {
  app.get('/', { ...read, schema: listSalesSchema }, async (request) => {
    return service.listSales(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getSaleSchema }, async (request) => {
    return service.getSale(app.db, request.params.id);
  });

  app.get('/:id/receipt', { ...read, schema: getSaleReceiptSchema }, async (request) => {
    return service.getSaleReceipt(app.db, request.params.id, app.config, request.query.paper_width_mm);
  });

  app.post('/', { ...write, schema: createSaleSchema }, async (request, reply) => {
    const result = await service.createSale(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updateSaleSchema }, async (request) => {
    return service.updateSale(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deleteSaleSchema }, async (request) => {
    return service.deleteSale(app.db, request.params.id);
  });

  app.post('/:id/hold', { ...write, schema: holdSaleSchema }, async (request) => {
    return service.holdSale(app.db, request.params.id, request.body?.hold_label ?? null);
  });

  app.post('/:id/resume', { ...write, schema: resumeSaleSchema }, async (request) => {
    return service.resumeSale(app.db, request.params.id);
  });

  app.post('/:id/complete', { ...write, schema: completeSaleSchema }, async (request, reply) => {
    const result = await service.completeSale(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/cancel', { ...write, schema: cancelSaleSchema }, async (request) => {
    return service.cancelSale(app.db, request.params.id);
  });
}
