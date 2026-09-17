import { buScope } from '../../../shared/auth/bu-scope.js';
import { guard } from '../../../shared/auth/role-matrix.js';
import * as service from './inbounds.service.js';
import {
  listInboundsSchema,
  getInboundSchema,
  createInboundSchema,
  updateInboundSchema,
  deleteInboundSchema,
  completeInboundSchema,
  cancelInboundSchema
} from './inbounds.schema.js';

const scope = buScope('inbounds');
const write = { onRequest: guard('inbounds', 'write'), preValidation: scope };
const read = { preValidation: scope };

export async function inboundsRoutes(app) {
  app.get('/', { ...read, schema: listInboundsSchema }, async (request) => {
    return service.listInbounds(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getInboundSchema }, async (request) => {
    return service.getInbound(app.db, request.params.id);
  });

  app.post('/', { ...write, schema: createInboundSchema }, async (request, reply) => {
    const result = await service.createInbound(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updateInboundSchema }, async (request) => {
    return service.updateInbound(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deleteInboundSchema }, async (request) => {
    return service.deleteInbound(app.db, request.params.id);
  });

  app.post('/:id/complete', { ...write, schema: completeInboundSchema }, async (request, reply) => {
    const result = await service.completeInbound(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/cancel', { ...write, schema: cancelInboundSchema }, async (request) => {
    return service.cancelInbound(app.db, request.params.id);
  });
}
