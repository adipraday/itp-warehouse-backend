import { buScope } from '../../../shared/auth/bu-scope.js';
import * as service from './stocks.service.js';
import { listStocksSchema, lowStockSchema, outOfStockSchema, exportStocksSchema } from './stocks.schema.js';

const scope = buScope('stocks');

export async function stocksRoutes(app) {
  app.get('/export', { preValidation: scope, schema: exportStocksSchema }, async (request, reply) => {
    const { buffer, contentType, extension } = await service.exportStocks(app.db, {
      status: request.query.status,
      warehouseId: request.query.warehouse_id ?? null,
      format: request.query.format,
      buIds: request.userContext?.buIds,
      assignedWarehouseIds: request.userContext?.assignedWarehouseIds
    });
    const suffix = request.query.status && request.query.status !== 'all' ? `-${request.query.status}` : '';
    reply.header('Content-Disposition', `attachment; filename="stocks-export${suffix}.${extension}"`);
    reply.type(contentType);
    return reply.send(buffer);
  });

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
