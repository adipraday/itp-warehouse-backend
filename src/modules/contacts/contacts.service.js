import { NotFoundError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { assertRowInScope } from '../../shared/auth/master-data-scope.js';
import * as repository from './contacts.repository.js';

export async function listContacts(db, query, buIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const type = query.type ?? null;
  const [data, total] = await Promise.all([
    repository.findAll(db, { type, buIds, limit: per_page, offset }),
    repository.count(db, { type, buIds })
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getContact(db, id, buIds = null) {
  const contact = await repository.findById(db, id);
  if (!contact) throw new NotFoundError(`Contact ${id} not found`);
  assertRowInScope(contact, buIds, 'contact');
  return { data: contact };
}

export async function createContact(db, payload, userId = null) {
  const contact = await repository.create(db, payload, userId);
  return { data: contact };
}

export async function updateContact(db, id, payload, buIds = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Contact ${id} not found`);
  assertRowInScope(existing, buIds, 'contact');

  const contact = await repository.update(db, id, payload);
  return { data: contact };
}
