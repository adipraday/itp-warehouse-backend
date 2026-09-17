import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './returns.service.js';
import {
  listItemReturnsSchema,
  getItemReturnSchema,
  createItemReturnSchema,
  updateItemReturnSchema,
  deleteItemReturnSchema,
  approveItemReturnSchema,
  completeItemReturnSchema,
  rejectItemReturnSchema,
  cancelItemReturnSchema
} from './returns.schema.js';

const scope = buScope('returns');
const write = { onRequest: guard('returns', 'write'), preValidation: scope };
const approve = { onRequest: guard('returns', 'approve'), preValidation: scope };
const reject = { onRequest: guard('returns', 'reject'), preValidation: scope };
const read = { preValidation: scope };

export async function returnsRoutes(app) {
  app.get('/', { ...read, schema: listItemReturnsSchema }, async (request) => {
    return service.listItemReturns(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getItemReturnSchema }, async (request) => {
    return service.getItemReturn(app.db, request.params.id);
  });

  app.post('/', { ...write, schema: createItemReturnSchema }, async (request, reply) => {
    const result = await service.createItemReturn(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updateItemReturnSchema }, async (request) => {
    return service.updateItemReturn(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deleteItemReturnSchema }, async (request) => {
    return service.deleteItemReturn(app.db, request.params.id);
  });

  app.post('/:id/approve', { ...approve, schema: approveItemReturnSchema }, async (request) => {
    return service.approveItemReturn(app.db, request.params.id, request.userContext?.userId);
  });

  app.post('/:id/complete', { ...write, schema: completeItemReturnSchema }, async (request, reply) => {
    const result = await service.completeItemReturn(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/reject', { ...reject, schema: rejectItemReturnSchema }, async (request) => {
    return service.rejectItemReturn(app.db, request.params.id);
  });

  app.post('/:id/cancel', { ...write, schema: cancelItemReturnSchema }, async (request) => {
    return service.cancelItemReturn(app.db, request.params.id);
  });
}
