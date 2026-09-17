import { authorize } from '../../shared/auth/authorize.js';
import { buScope } from '../../shared/auth/bu-scope.js';
import { HPP_VISIBLE_ROLES } from '../../shared/auth/role-matrix.js';
import * as service from './dashboard.service.js';
import {
  dashboardSummarySchema,
  dashboardStockSchema,
  dashboardSalesSchema,
  dashboardPurchasesSchema,
  dashboardProfitSchema
} from './dashboard.schema.js';

const scope = buScope('dashboard');
// COGS/gross-margin — HPP data, hidden from staff-gudang/kasir-sales like the rest.
const hppGuard = authorize(...HPP_VISIBLE_ROLES);

export async function dashboardRoutes(app) {
  app.get('/summary', { preValidation: scope, schema: dashboardSummarySchema }, async (request) => {
    return service.getSummary(app.db, request.query, request.userContext?.buIds, request.userContext?.assignedWarehouseIds);
  });

  app.get('/stock', { preValidation: scope, schema: dashboardStockSchema }, async (request) => {
    return service.getStockDashboard(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/sales', { preValidation: scope, schema: dashboardSalesSchema }, async (request) => {
    return service.getSalesDashboard(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/purchases', { preValidation: scope, schema: dashboardPurchasesSchema }, async (request) => {
    return service.getPurchasesDashboard(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/profit', { onRequest: hppGuard, preValidation: scope, schema: dashboardProfitSchema }, async (request) => {
    return service.getProfitDashboard(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });
}
