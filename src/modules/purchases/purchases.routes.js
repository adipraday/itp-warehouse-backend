import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './purchases.service.js';
import {
  listPurchasesSchema,
  getPurchaseSchema,
  createPurchaseSchema,
  updatePurchaseSchema,
  deletePurchaseSchema,
  completePurchaseSchema,
  cancelPurchaseSchema
} from './purchases.schema.js';

const scope = buScope('purchases');
const write = { onRequest: guard('purchases', 'write'), preValidation: scope };
const read = { preValidation: scope };

export async function purchasesRoutes(app) {
  app.get('/', { ...read, schema: listPurchasesSchema }, async (request) => {
    return service.listPurchases(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getPurchaseSchema }, async (request) => {
    return service.getPurchase(app.db, request.params.id);
  });

  app.post('/', { ...write, schema: createPurchaseSchema }, async (request, reply) => {
    const result = await service.createPurchase(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updatePurchaseSchema }, async (request) => {
    return service.updatePurchase(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deletePurchaseSchema }, async (request) => {
    return service.deletePurchase(app.db, request.params.id);
  });

  app.post('/:id/complete', { ...write, schema: completePurchaseSchema }, async (request, reply) => {
    const result = await service.completePurchase(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/cancel', { ...write, schema: cancelPurchaseSchema }, async (request) => {
    return service.cancelPurchase(app.db, request.params.id);
  });
}
