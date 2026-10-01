import { NotFoundError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import * as repository from './notifications.repository.js';

export async function listNotifications(db, query, userId) {
  const { page, per_page, offset } = parsePagination(query);
  const [data, total] = await Promise.all([
    repository.findByUser(db, userId, { limit: per_page, offset }),
    repository.countByUser(db, userId)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getUnreadCount(db, userId) {
  const count = await repository.countUnreadByUser(db, userId);
  return { data: { count } };
}

export async function markNotificationRead(db, id, userId) {
  const notification = await repository.findByIdAndUser(db, id, userId);
  if (!notification) throw new NotFoundError(`Notification ${id} not found`);
  await repository.markRead(db, id, userId);
  return { data: { ...notification, is_read: true } };
}

export async function markAllNotificationsRead(db, userId) {
  const updated_count = await repository.markAllRead(db, userId);
  return { data: { updated_count } };
}
