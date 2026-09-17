import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './contacts.service.js';
import { listContactsSchema, getContactSchema, createContactSchema, updateContactSchema } from './contacts.schema.js';

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

export async function contactsRoutes(app) {
  app.get('/', { schema: listContactsSchema }, async (request) => {
    return service.listContacts(app.db, request.query, request.userContext?.buIds);
  });

  app.get('/:id', { schema: getContactSchema }, async (request) => {
    return service.getContact(app.db, request.params.id, request.userContext?.buIds);
  });

  app.post('/', { onRequest: guard('contacts', 'write'), schema: createContactSchema }, async (request, reply) => {
    const result = await service.createContact(
      app.db,
      { ...request.body, bu_id: effectiveBuId(request) },
      request.userContext?.userId
    );
    reply.status(201);
    return result;
  });

  app.put('/:id', { onRequest: guard('contacts', 'write'), schema: updateContactSchema }, async (request) => {
    return service.updateContact(
      app.db,
      request.params.id,
      { ...request.body, bu_id: effectiveBuId(request) },
      request.userContext?.buIds
    );
  });
}
