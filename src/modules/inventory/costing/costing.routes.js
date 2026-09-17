import { authorize } from '../../../shared/auth/authorize.js';
import { buScope } from '../../../shared/auth/bu-scope.js';
import { HPP_VISIBLE_ROLES } from '../../../shared/auth/role-matrix.js';
import * as service from './costing.service.js';
import { listCostLayersSchema, getCostLayerSchema, costSummarySchema } from './costing.schema.js';

const layersScope = buScope('cost-layers');
const summaryScope = buScope('cost-summary');
// HPP data — hidden from staff-gudang/kasir-sales, see role-matrix.js.
const hppGuard = authorize(...HPP_VISIBLE_ROLES);

export async function costLayersRoutes(app) {
  app.get('/', { onRequest: hppGuard, preValidation: layersScope, schema: listCostLayersSchema }, async (request) => {
    return service.listCostLayers(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { onRequest: hppGuard, preValidation: layersScope, schema: getCostLayerSchema }, async (request) => {
    return service.getCostLayer(app.db, request.params.id);
  });
}

export async function costSummaryRoutes(app) {
  app.get('/', { onRequest: hppGuard, preValidation: summaryScope, schema: costSummarySchema }, async (request) => {
    return service.getCostSummary(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });
}
