import { buScope } from '../../../shared/auth/bu-scope.js';
import * as service from './stocks.service.js';
import { listStocksSchema, lowStockSchema, outOfStockSchema } from './stocks.schema.js';

const scope = buScope('stocks');

export async function stocksRoutes(app) {
  app.get('/low-stock', { preValidation: scope, schema: lowStockSchema }, async (request) => {
    return service.listLowStock(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/out-of-stock', { preValidation: scope, schema: outOfStockSchema }, async (request) => {
    return service.listOutOfStock(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/', { preValidation: scope, schema: listStocksSchema }, async (request) => {
    return service.listStocks(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });
}
