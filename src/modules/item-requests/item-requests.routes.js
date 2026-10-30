import { guard } from '../../shared/auth/role-matrix.js';
import * as service from './item-requests.service.js';
import {
  listItemRequestsSchema,
  getItemRequestSchema,
  createItemRequestSchema,
  changeItemRequestStatusSchema,
  cancelItemRequestSchema
} from './item-requests.schema.js';

// A request belongs to a business unit, not to one warehouse, so the per-warehouse buScope()/staff
// assignment filters are deliberately not used here: everyone in the BU may read the list and file
// a request. Scoping to the BU happens in the service; which warehouse a handler may work on
// (service.assertMayHandle) is the only assignment rule.
export async function itemRequestsRoutes(app) {
  app.get('/', { schema: listItemRequestsSchema }, async (request) => {
    return service.listItemRequests(app.db, request.query, request.userContext);
  });

  app.get('/:id', { schema: getItemRequestSchema }, async (request) => {
    return service.getItemRequest(app.db, request.params.id, request.userContext?.buIds, request.userContext);
  });

  app.post('/', { onRequest: guard('item-requests', 'write'), schema: createItemRequestSchema }, async (request, reply) => {
    const result = await service.createItemRequest(app.db, request.body, request.userContext);
    reply.status(result.statusCode);
    return result.body;
  });

  app.post(
    '/:id/status',
    { onRequest: guard('item-requests', 'handle'), schema: changeItemRequestStatusSchema },
    async (request) => {
      return service.changeItemRequestStatus(app.db, request.params.id, request.body, request.userContext);
    }
  );

  app.post(
    '/:id/cancel',
    { onRequest: guard('item-requests', 'write'), schema: cancelItemRequestSchema },
    async (request) => {
      return service.cancelItemRequest(app.db, request.params.id, request.body ?? {}, request.userContext);
    }
  );
}
