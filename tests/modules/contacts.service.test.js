import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/contacts/contacts.repository.js';
import * as service from '../../src/modules/contacts/contacts.service.js';

vi.mock('../../src/modules/contacts/contacts.repository.js');

const fakeDb = {};

describe('contacts.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('listContacts returns a paginated envelope', async () => {
    repository.findAll.mockResolvedValue([{ id: 1, type: 'supplier', name: 'PT Sumber Jaya' }]);
    repository.count.mockResolvedValue(1);

    const result = await service.listContacts(fakeDb, { page: '1', per_page: '20' });

    expect(result).toEqual({
      data: [{ id: 1, type: 'supplier', name: 'PT Sumber Jaya' }],
      meta: { page: 1, per_page: 20, total: 1 }
    });
    expect(repository.findAll).toHaveBeenCalledWith(fakeDb, { type: null, buIds: null, limit: 20, offset: 0 });
  });

  it('listContacts passes the type filter through to the repository', async () => {
    repository.findAll.mockResolvedValue([]);
    repository.count.mockResolvedValue(0);

    await service.listContacts(fakeDb, { type: 'supplier' });

    expect(repository.findAll).toHaveBeenCalledWith(fakeDb, { type: 'supplier', buIds: null, limit: 20, offset: 0 });
    expect(repository.count).toHaveBeenCalledWith(fakeDb, { type: 'supplier', buIds: null });
  });

  it('getContact throws a 404 NotFoundError when the contact does not exist', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.getContact(fakeDb, 999)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND'
    });
  });

  it('createContact creates the contact', async () => {
    repository.create.mockResolvedValue({ id: 1, type: 'customer', name: 'Budi' });

    const result = await service.createContact(fakeDb, { type: 'customer', name: 'Budi' });

    expect(result).toEqual({ data: { id: 1, type: 'customer', name: 'Budi' } });
  });

  it('updateContact throws 404 when the contact does not exist', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(
      service.updateContact(fakeDb, 999, { type: 'customer', name: 'Budi' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updateContact updates the contact when it exists', async () => {
    repository.findById.mockResolvedValue({ id: 1, type: 'customer', name: 'Budi' });
    repository.update.mockResolvedValue({ id: 1, type: 'both', name: 'Budi Santoso' });

    const result = await service.updateContact(fakeDb, 1, { type: 'both', name: 'Budi Santoso' });

    expect(result).toEqual({ data: { id: 1, type: 'both', name: 'Budi Santoso' } });
  });
});

// Regression coverage for the 2026-09-08 cross-tenant leak: contacts now
// carry their own bu_id and must be scoped like items/warehouses.
describe('contacts.service — bu_id scoping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('getContact rejects a contact outside the caller\'s business units', async () => {
    repository.findById.mockResolvedValue({ id: 1, name: 'Budi', bu_id: 99 });

    await expect(service.getContact(fakeDb, 1, [11, 12])).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN'
    });
  });

  it('getContact passes for a contact inside the caller\'s business units', async () => {
    repository.findById.mockResolvedValue({ id: 1, name: 'Budi', bu_id: 11 });

    await expect(service.getContact(fakeDb, 1, [11, 12])).resolves.toMatchObject({
      data: { id: 1 }
    });
  });

  it('updateContact rejects a contact outside the caller\'s business units before touching it', async () => {
    repository.findById.mockResolvedValue({ id: 1, name: 'Budi', bu_id: 99 });

    await expect(
      service.updateContact(fakeDb, 1, { type: 'customer', name: 'Budi' }, [11])
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.update).not.toHaveBeenCalled();
  });
});
