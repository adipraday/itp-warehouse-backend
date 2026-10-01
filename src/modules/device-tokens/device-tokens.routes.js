import * as service from './device-tokens.service.js';
import { registerDeviceTokenSchema, unregisterDeviceTokenSchema } from './device-tokens.schema.js';

// No guard() here — every authenticated role registers/unregisters its own
// device token, there's no resource-level permission to check beyond "is
// this caller authenticated at all" (already enforced globally by
// registerUserContext on every /api/* route).
export async function deviceTokensRoutes(app) {
  app.post('/', { schema: registerDeviceTokenSchema }, async (request) => {
    return service.registerDeviceToken(app.db, request.body, request.userContext);
  });

  // DELETE with a body (not /:token) — FCM tokens contain characters
  // (/, +, =) that would need escaping in a URL segment; Fastify supports a
  // DELETE body fine.
  app.delete('/', { schema: unregisterDeviceTokenSchema }, async (request) => {
    return service.unregisterDeviceToken(app.db, request.body.fcm_token);
  });
}
