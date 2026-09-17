import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './stock-opnames.service.js';
import {
  listStockOpnamesSchema,
  getStockOpnameSchema,
  createStockOpnameSchema,
  updateStockOpnameSchema,
  deleteStockOpnameSchema,
  submitStockOpnameSchema,
  approveStockOpnameSchema,
  cancelStockOpnameSchema
} from './stock-opnames.schema.js';

const scope = buScope('stock-opnames');
const write = { onRequest: guard('stock-opnames', 'write'), preValidation: scope };
const submit = { onRequest: guard('stock-opnames', 'submit'), preValidation: scope };
const approve = { onRequest: guard('stock-opnames', 'approve'), preValidation: scope };
const read = { preValidation: scope };

export async function stockOpnamesRoutes(app) {
  app.get('/', { ...read, schema: listStockOpnamesSchema }, async (request) => {
    return service.listStockOpnames(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getStockOpnameSchema }, async (request) => {
    return service.getStockOpname(app.db, request.params.id);
  });

  app.post('/', { ...write, schema: createStockOpnameSchema }, async (request, reply) => {
    const result = await service.createStockOpname(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updateStockOpnameSchema }, async (request) => {
    return service.updateStockOpname(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deleteStockOpnameSchema }, async (request) => {
    return service.deleteStockOpname(app.db, request.params.id);
  });

  app.post('/:id/submit', { ...submit, schema: submitStockOpnameSchema }, async (request) => {
    return service.submitStockOpname(app.db, request.params.id);
  });

  app.post('/:id/approve', { ...approve, schema: approveStockOpnameSchema }, async (request, reply) => {
    const result = await service.approveStockOpname(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/cancel', { ...write, schema: cancelStockOpnameSchema }, async (request) => {
    return service.cancelStockOpname(app.db, request.params.id);
  });
}
