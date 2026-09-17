import { buScope } from '../../../shared/auth/bu-scope.js';
import { guard } from '../../../shared/auth/role-matrix.js';
import * as service from './outbounds.service.js';
import {
  listOutboundsSchema,
  getOutboundSchema,
  createOutboundSchema,
  updateOutboundSchema,
  deleteOutboundSchema,
  completeOutboundSchema,
  cancelOutboundSchema
} from './outbounds.schema.js';

const scope = buScope('outbounds');
const write = { onRequest: guard('outbounds', 'write'), preValidation: scope };
const read = { preValidation: scope };

export async function outboundsRoutes(app) {
  app.get('/', { ...read, schema: listOutboundsSchema }, async (request) => {
    return service.listOutbounds(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getOutboundSchema }, async (request) => {
    return service.getOutbound(app.db, request.params.id);
  });

  app.post('/', { ...write, schema: createOutboundSchema }, async (request, reply) => {
    const result = await service.createOutbound(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updateOutboundSchema }, async (request) => {
    return service.updateOutbound(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deleteOutboundSchema }, async (request) => {
    return service.deleteOutbound(app.db, request.params.id);
  });

  app.post('/:id/complete', { ...write, schema: completeOutboundSchema }, async (request, reply) => {
    const result = await service.completeOutbound(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/cancel', { ...write, schema: cancelOutboundSchema }, async (request) => {
    return service.cancelOutbound(app.db, request.params.id);
  });
}
