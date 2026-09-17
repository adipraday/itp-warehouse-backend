import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './stock-transfers.service.js';
import {
  listStockTransfersSchema,
  getStockTransferSchema,
  createStockTransferSchema,
  updateStockTransferSchema,
  deleteStockTransferSchema,
  approveStockTransferSchema,
  completeStockTransferSchema,
  cancelStockTransferSchema
} from './stock-transfers.schema.js';

const scope = buScope('stock-transfers');
const write = { onRequest: guard('stock-transfers', 'write'), preValidation: scope };
const approve = { onRequest: guard('stock-transfers', 'approve'), preValidation: scope };
const read = { preValidation: scope };

export async function stockTransfersRoutes(app) {
  app.get('/', { ...read, schema: listStockTransfersSchema }, async (request) => {
    return service.listStockTransfers(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getStockTransferSchema }, async (request) => {
    return service.getStockTransfer(app.db, request.params.id);
  });

  app.post('/', { ...write, schema: createStockTransferSchema }, async (request, reply) => {
    const result = await service.createStockTransfer(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updateStockTransferSchema }, async (request) => {
    return service.updateStockTransfer(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deleteStockTransferSchema }, async (request) => {
    return service.deleteStockTransfer(app.db, request.params.id);
  });

  app.post('/:id/approve', { ...approve, schema: approveStockTransferSchema }, async (request) => {
    return service.approveStockTransfer(app.db, request.params.id, request.userContext?.userId);
  });

  app.post('/:id/complete', { ...write, schema: completeStockTransferSchema }, async (request, reply) => {
    const result = await service.completeStockTransfer(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/cancel', { ...write, schema: cancelStockTransferSchema }, async (request) => {
    return service.cancelStockTransfer(app.db, request.params.id);
  });
}
