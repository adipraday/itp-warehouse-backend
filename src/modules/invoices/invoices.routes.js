import { buScope } from '../../shared/auth/bu-scope.js';
import * as service from './invoices.service.js';
import * as paymentsService from '../payments/payments.service.js';
import { listInvoicesSchema, getInvoiceSchema, listInvoicePaymentsSchema } from './invoices.schema.js';

const scope = buScope('invoices');

export async function invoicesRoutes(app) {
  app.get('/', { preValidation: scope, schema: listInvoicesSchema }, async (request) => {
    return service.listInvoices(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { preValidation: scope, schema: getInvoiceSchema }, async (request) => {
    return service.getInvoice(app.db, request.params.id);
  });

  app.get('/:id/payments', { preValidation: scope, schema: listInvoicePaymentsSchema }, async (request) => {
    return paymentsService.listInvoicePayments(app.db, request.params.id, request.query);
  });
}
