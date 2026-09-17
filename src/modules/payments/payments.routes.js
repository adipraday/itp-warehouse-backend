import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './payments.service.js';
import { listPaymentsSchema, getPaymentSchema, createPaymentSchema } from './payments.schema.js';

const scope = buScope('payments');

export async function paymentsRoutes(app) {
  app.get('/', { preValidation: scope, schema: listPaymentsSchema }, async (request) => {
    return service.listPayments(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { preValidation: scope, schema: getPaymentSchema }, async (request) => {
    return service.getPayment(app.db, request.params.id);
  });

  app.post(
    '/',
    { onRequest: guard('payments', 'write'), preValidation: scope, schema: createPaymentSchema },
    async (request, reply) => {
      const result = await service.createPayment(app.db, request.body, request.userContext?.userId);
      reply.status(201);
      return result;
    }
  );
}
