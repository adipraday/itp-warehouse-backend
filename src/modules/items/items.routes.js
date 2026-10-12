import { guard } from '../../shared/auth/role-matrix.js';
import { buScope } from '../../shared/auth/bu-scope.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import * as service from './items.service.js';
import { importItems } from './items-import.service.js';
import { buildImportTemplate, exportItems } from './items-export.service.js';
import {
  listItemsSchema,
  getItemSchema,
  createItemSchema,
  updateItemSchema,
  searchItemsSchema,
  getItemByBarcodeSchema,
  importItemsSchema,
  importTemplateSchema,
  exportItemsSchema,
  listItemStocksSchema,
  itemCostSchema,
  itemCostHistorySchema
} from './items.schema.js';

// 'items' has no DOC_WAREHOUSE_SQL entry, so this only ever validates an
// explicit ?warehouse_id — used by both the barcode lookup and the
// per-warehouse export below.
const itemsWarehouseScope = buScope('items');

function sendFile(reply, { buffer, contentType, extension }, filenameBase) {
  reply.header('Content-Disposition', `attachment; filename="${filenameBase}.${extension}"`);
  reply.type(contentType);
  return reply.send(buffer);
}

// super-admin (buIds null) may set/keep any bu_id. A scoped caller may
// explicitly pick any ONE of their own allowed BUs — same pattern as
// warehouses.routes.js's effectiveBuId().
function effectiveBuId(request) {
  const ctx = request.userContext;
  if (!ctx || ctx.buIds == null) {
    return request.body?.bu_id ?? null;
  }
  const requested = request.body?.bu_id;
  if (requested != null && ctx.buIds.map(Number).includes(Number(requested))) {
    return Number(requested);
  }
  return ctx.buId;
}

export async function itemsRoutes(app) {
  app.get('/', { schema: listItemsSchema }, async (request) => {
    return service.listItems(app.db, request.query, request.userContext?.buIds);
  });

  app.get('/search', { schema: searchItemsSchema }, async (request) => {
    return service.searchItems(app.db, request.query, request.userContext?.buIds);
  });

  // Must be registered before /:id — a distinct static prefix ('/by-barcode/...'
  // has two path segments vs one), so there's no routing ambiguity either way,
  // but keeping it grouped with /search here for readability.
  app.get('/by-barcode/:barcode', { preValidation: itemsWarehouseScope, schema: getItemByBarcodeSchema }, async (request) => {
    return service.getItemByBarcode(
      app.db,
      request.params.barcode,
      request.query.warehouse_id ?? null,
      request.userContext?.buIds
    );
  });

  // Must be registered before /:id — same reasoning as /search and /by-barcode.
  app.post('/import', { onRequest: guard('items', 'write'), schema: importItemsSchema }, async (request) => {
    const file = await request.file();
    if (!file) throw new BadRequestError('FILE_REQUIRED', 'Upload a .csv or .xlsx file under the "file" field');
    const buffer = await file.toBuffer();

    return importItems(
      app.db,
      { buffer, filename: file.filename, mimetype: file.mimetype },
      { userId: request.userContext?.userId, buId: request.userContext?.buId }
    );
  });

  // Must be registered before /:id — same reasoning as /search and /by-barcode.
  app.get('/import/template', { schema: importTemplateSchema }, async (request, reply) => {
    const file = await buildImportTemplate(request.query.format);
    return sendFile(reply, file, 'items-import-template');
  });

  app.get('/export', { preValidation: itemsWarehouseScope, schema: exportItemsSchema }, async (request, reply) => {
    const file = await exportItems(app.db, {
      buIds: request.userContext?.buIds,
      warehouseId: request.query.warehouse_id ?? null,
      format: request.query.format
    });
    return sendFile(reply, file, 'items-export');
  });

  app.get('/:id', { schema: getItemSchema }, async (request) => {
    return service.getItem(app.db, request.params.id, request.userContext?.buIds);
  });

  app.post('/', { onRequest: guard('items', 'write'), schema: createItemSchema }, async (request, reply) => {
    const result = await service.createItem(
      app.db,
      { ...request.body, bu_id: effectiveBuId(request) },
      request.userContext?.userId
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { onRequest: guard('items', 'write'), schema: updateItemSchema }, async (request) => {
    return service.updateItem(
      app.db,
      request.params.id,
      { ...request.body, bu_id: effectiveBuId(request) },
      request.userContext?.buIds
    );
  });

  app.get('/:id/stocks', { schema: listItemStocksSchema }, async (request) => {
    return service.listItemStocks(app.db, request.params.id, request.query, request.userContext?.buIds);
  });

  app.get('/:id/cost', { schema: itemCostSchema }, async (request) => {
    return service.getItemCost(app.db, request.params.id, request.query, request.userContext?.buIds);
  });

  app.get('/:id/cost-history', { schema: itemCostHistorySchema }, async (request) => {
    return service.getItemCostHistory(app.db, request.params.id, request.query, request.userContext?.buIds);
  });
}
