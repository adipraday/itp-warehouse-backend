import { buScope } from '../../../shared/auth/bu-scope.js';
import * as service from './stock-mutations.service.js';
import { listStockMutationsSchema, getStockMutationSchema } from './stock-mutations.schema.js';

const scope = buScope('stock-mutations');

export async function stockMutationsRoutes(app) {
  app.get('/', { preValidation: scope, schema: listStockMutationsSchema }, async (request) => {
    return service.listStockMutations(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { preValidation: scope, schema: getStockMutationSchema }, async (request) => {
    return service.getStockMutation(app.db, request.params.id);
  });
}
