import { buScope } from '../../shared/auth/bu-scope.js';
import { guard } from '../../shared/auth/role-matrix.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import * as service from './purchases.service.js';
import {
  listPurchasesSchema,
  getPurchaseSchema,
  createPurchaseSchema,
  updatePurchaseSchema,
  deletePurchaseSchema,
  submitPurchaseSchema,
  receivePurchaseSchema,
  completePurchaseSchema,
  cancelPurchaseSchema,
  recordRefundSchema,
  updateSupplierInvoiceSchema,
  uploadSupplierInvoiceFileSchema,
  downloadSupplierInvoiceFileSchema,
  deleteSupplierInvoiceFileSchema
} from './purchases.schema.js';

const scope = buScope('purchases');
const write = { onRequest: guard('purchases', 'write'), preValidation: scope };
const approve = { onRequest: guard('purchases', 'approve'), preValidation: scope };
const refund = { onRequest: guard('purchases', 'refund'), preValidation: scope };
const read = { preValidation: scope };

export async function purchasesRoutes(app) {
  app.get('/', { ...read, schema: listPurchasesSchema }, async (request) => {
    return service.listPurchases(
      app.db,
      request.query,
      request.userContext?.buIds,
      request.userContext?.assignedWarehouseIds
    );
  });

  app.get('/:id', { ...read, schema: getPurchaseSchema }, async (request) => {
    return service.getPurchase(app.db, request.params.id);
  });

  app.post('/', { ...write, schema: createPurchaseSchema }, async (request, reply) => {
    const result = await service.createPurchase(
      app.db,
      request.body,
      request.userContext?.userId,
      request.userContext?.buIds
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { ...write, schema: updatePurchaseSchema }, async (request) => {
    return service.updatePurchase(app.db, request.params.id, request.body, request.userContext?.buIds);
  });

  app.delete('/:id', { ...write, schema: deletePurchaseSchema }, async (request) => {
    return service.deletePurchase(app.db, request.params.id);
  });

  // Paid → handed to the destination warehouse for approval.
  app.post('/:id/submit', { ...write, schema: submitPurchaseSchema }, async (request) => {
    return service.submitPurchase(app.db, request.params.id, request.userContext?.userId);
  });

  // Warehouse approval with the quantities actually received (partial receipt allowed).
  app.post('/:id/receive', { ...approve, schema: receivePurchaseSchema }, async (request, reply) => {
    const result = await service.receivePurchase(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId,
      context: request.userContext,
      lines: request.body?.lines,
      shortfallAction: request.body?.shortfall_action,
      notes: request.body?.notes
    });
    reply.status(result.statusCode);
    return result.body;
  });

  // Approve everything outstanding as received in full — same as /receive without `lines`. Kept so
  // existing clients keep working; it never skips the submit/approval steps.
  app.post('/:id/complete', { ...approve, schema: completePurchaseSchema }, async (request, reply) => {
    const result = await service.receivePurchase(app.db, request.params.id, {
      idempotencyKey: request.headers['idempotency-key'],
      endpoint: `${request.method} ${request.url}`,
      body: request.body,
      ttlHours: app.config.IDEMPOTENCY_TTL_HOURS,
      userId: request.userContext?.userId,
      context: request.userContext
    });
    reply.status(result.statusCode);
    return result.body;
  });

  app.post('/:id/cancel', { ...write, schema: cancelPurchaseSchema }, async (request) => {
    return service.cancelPurchase(app.db, request.params.id, request.body ?? {}, request.userContext?.userId);
  });

  app.post('/:id/refunds', { ...refund, schema: recordRefundSchema }, async (request, reply) => {
    const result = await service.recordRefund(app.db, request.params.id, request.body, request.userContext?.userId);
    reply.status(201);
    return result;
  });

  // ---- Supplier's own invoice: number + PDF ----
  app.put('/:id/supplier-invoice', { ...write, schema: updateSupplierInvoiceSchema }, async (request) => {
    return service.updateSupplierInvoiceNumber(app.db, request.params.id, request.body.supplier_invoice_number);
  });

  app.post('/:id/supplier-invoice-file', { ...write, schema: uploadSupplierInvoiceFileSchema }, async (request) => {
    const file = await request.file();
    if (!file) throw new BadRequestError('FILE_REQUIRED', 'Upload a PDF under the "file" field');
    let buffer;
    try {
      buffer = await file.toBuffer();
    } catch (error) {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new BadRequestError('FILE_TOO_LARGE', 'The PDF must be 10 MB or smaller');
      }
      throw error;
    }
    return service.uploadSupplierInvoiceFile(app.db, app.storage, request.params.id, {
      buffer,
      filename: file.filename,
      mimetype: file.mimetype,
      truncated: file.file?.truncated
    });
  });

  app.get('/:id/supplier-invoice-file', { ...read, schema: downloadSupplierInvoiceFileSchema }, async (request, reply) => {
    const { body, filename } = await service.getSupplierInvoiceFile(app.db, app.storage, request.params.id);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'private, no-store');
    return reply.send(body);
  });

  app.delete('/:id/supplier-invoice-file', { ...write, schema: deleteSupplierInvoiceFileSchema }, async (request) => {
    return service.deleteSupplierInvoiceFile(app.db, app.storage, request.params.id);
  });
}
