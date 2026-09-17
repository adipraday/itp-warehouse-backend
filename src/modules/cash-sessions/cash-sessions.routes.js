import { guard } from '../../shared/auth/role-matrix.js';
import { buScope } from '../../shared/auth/bu-scope.js';
import * as service from './cash-sessions.service.js';
import {
  listCashSessionsSchema,
  getCashSessionSchema,
  getCurrentCashSessionSchema,
  openCashSessionSchema,
  addExpenseSchema,
  closeCashSessionSchema
} from './cash-sessions.schema.js';

// 'cash-sessions' has a DOC_WAREHOUSE_SQL entry in bu-scope.js, so :id routes
// (close, get) get their warehouse resolved and checked automatically; open's
// warehouse_id is a plain body field, already covered by buScope()'s generic
// BODY_KEYS check.
const scope = buScope('cash-sessions');
const write = { onRequest: guard('cash-sessions', 'write'), preValidation: scope };
const read = { preValidation: scope };

export async function cashSessionsRoutes(app) {
  app.get('/', { schema: listCashSessionsSchema }, async (request) => {
    return service.listCashSessions(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  // Must be registered before /:id — same reasoning as items' /by-barcode/:barcode.
  app.get('/current', { schema: getCurrentCashSessionSchema }, async (request) => {
    return service.getCurrentCashSession(app.db, request.userContext?.userId);
  });

  app.get('/:id', { ...read, schema: getCashSessionSchema }, async (request) => {
    return service.getCashSession(app.db, request.params.id);
  });

  app.post('/open', { ...write, schema: openCashSessionSchema }, async (request, reply) => {
    const result = await service.openCashSession(app.db, request.body, request.userContext?.userId);
    reply.status(201);
    return result;
  });

  app.post('/:id/expenses', { ...write, schema: addExpenseSchema }, async (request) => {
    return service.addExpense(app.db, request.params.id, request.body, request.userContext?.userId);
  });

  app.post('/:id/close', { ...write, schema: closeCashSessionSchema }, async (request) => {
    return service.closeCashSession(app.db, request.params.id, request.body);
  });
}
