import * as service from './notifications.service.js';
import {
  listNotificationsSchema,
  unreadCountSchema,
  markNotificationReadSchema,
  markAllNotificationsReadSchema
} from './notifications.schema.js';

// No guard() here — every authenticated role only ever reads/mutates their
// own notifications, scoped by request.userContext.userId (already enforced
// globally by registerUserContext on every /api/* route). Same convention as
// device-tokens.routes.js.
export async function notificationsRoutes(app) {
  app.get('/', { schema: listNotificationsSchema }, async (request) => {
    return service.listNotifications(app.db, request.query, request.userContext.userId);
  });

  app.get('/unread-count', { schema: unreadCountSchema }, async (request) => {
    return service.getUnreadCount(app.db, request.userContext.userId);
  });

  app.patch('/read-all', { schema: markAllNotificationsReadSchema }, async (request) => {
    return service.markAllNotificationsRead(app.db, request.userContext.userId);
  });

  app.patch('/:id/read', { schema: markNotificationReadSchema }, async (request) => {
    return service.markNotificationRead(app.db, request.params.id, request.userContext.userId);
  });
}
