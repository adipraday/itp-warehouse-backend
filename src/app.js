import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { createPool } from './config/database.js';
import { registerEnv } from './config/env.js';
import { errorHandler } from './plugins/error-handler.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerUserContext } from './shared/auth/user-context.js';
import { registerWarehouseAssignment } from './shared/auth/warehouse-assignment.js';
import { registerActivityLog } from './shared/activity-log/log-hook.js';
import { activityLogsRoutes } from './modules/activity-logs/activity-logs.routes.js';
import { meRoutes } from './modules/me/me.routes.js';
import { userWarehouseAssignmentsRoutes } from './modules/user-warehouse-assignments/user-warehouse-assignments.routes.js';
import { warehousesRoutes } from './modules/warehouses/warehouses.routes.js';
import { itemsRoutes } from './modules/items/items.routes.js';
import { contactsRoutes } from './modules/contacts/contacts.routes.js';
import { stocksRoutes } from './modules/inventory/stocks/stocks.routes.js';
import { stockMutationsRoutes } from './modules/inventory/stock-mutations/stock-mutations.routes.js';
import { costLayersRoutes, costSummaryRoutes } from './modules/inventory/costing/costing.routes.js';
import { inboundsRoutes } from './modules/inventory/inbounds/inbounds.routes.js';
import { outboundsRoutes } from './modules/inventory/outbounds/outbounds.routes.js';
import { stockTransfersRoutes } from './modules/stock-transfers/stock-transfers.routes.js';
import { stockOpnamesRoutes } from './modules/stock-opnames/stock-opnames.routes.js';
import { salesRoutes } from './modules/sales/sales.routes.js';
import { cashSessionsRoutes } from './modules/cash-sessions/cash-sessions.routes.js';
import { purchasesRoutes } from './modules/purchases/purchases.routes.js';
import { invoicesRoutes } from './modules/invoices/invoices.routes.js';
import { paymentsRoutes } from './modules/payments/payments.routes.js';
import { returnsRoutes } from './modules/returns/returns.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';

export async function buildApp({ logger = true } = {}) {
  const app = Fastify({ logger });
  await registerEnv(app);

  // CORS_ORIGIN dibaca sebagai string mentah dari env (bisa comma-separated buat multi-origin
  // produksi, mis. "https://a.com,https://b.com") — @fastify/cors kalau dikasih string biasa
  // nganggepnya SATU origin literal yang selalu di-echo apa adanya, BUKAN di-split per koma.
  // Akibatnya browser bakal nolak response (Access-Control-Allow-Origin cuma boleh 1 nilai per
  // spec CORS) begitu CORS_ORIGIN diisi lebih dari 1 domain. Ditemukan & di-fix live di VPS
  // (2026-09-16) pas nambah domain frontend kedua — di-propagate ke sini biar nggak ke-overwrite
  // deploy berikutnya.
  await app.register(cors, {
    origin: app.config.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  });
  // 10MB cap — a bulk item/stock import spreadsheet, not arbitrary file storage.
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await registerSwagger(app);

  const pool = createPool(app.config);
  app.decorate('db', pool);
  app.addHook('onClose', async () => pool.end());
  app.setErrorHandler(errorHandler);

  await registerUserContext(app);
  // Must run after registerUserContext (needs request.userContext.userId/role)
  // and before every /api/* route — resolves per-warehouse staff scoping and
  // hard-blocks an unassigned staff user. See src/shared/auth/warehouse-assignment.js.
  await registerWarehouseAssignment(app);
  await registerActivityLog(app);

  app.get('/health', {
    schema: { response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { status: { type: 'string' } } } } } } }
  }, async () => ({ data: { status: 'ok' } }));

  await app.register(warehousesRoutes, { prefix: '/api/warehouses' });
  await app.register(itemsRoutes, { prefix: '/api/items' });
  await app.register(contactsRoutes, { prefix: '/api/contacts' });
  await app.register(stocksRoutes, { prefix: '/api/stocks' });
  await app.register(stockMutationsRoutes, { prefix: '/api/stock-mutations' });
  await app.register(costLayersRoutes, { prefix: '/api/cost-layers' });
  await app.register(costSummaryRoutes, { prefix: '/api/cost-summary' });
  await app.register(inboundsRoutes, { prefix: '/api/inbounds' });
  await app.register(outboundsRoutes, { prefix: '/api/outbounds' });
  await app.register(stockTransfersRoutes, { prefix: '/api/stock-transfers' });
  await app.register(stockOpnamesRoutes, { prefix: '/api/stock-opnames' });
  await app.register(salesRoutes, { prefix: '/api/sales' });
  await app.register(cashSessionsRoutes, { prefix: '/api/cash-sessions' });
  await app.register(purchasesRoutes, { prefix: '/api/purchases' });
  await app.register(invoicesRoutes, { prefix: '/api/invoices' });
  await app.register(paymentsRoutes, { prefix: '/api/payments' });
  await app.register(returnsRoutes, { prefix: '/api/returns' });
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  await app.register(activityLogsRoutes, { prefix: '/api/activity-logs' });
  await app.register(meRoutes, { prefix: '/api/me' });
  await app.register(userWarehouseAssignmentsRoutes, { prefix: '/api/user-warehouse-assignments' });

  return app;
}
