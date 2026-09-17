import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/user-warehouse-assignments/user-warehouse-assignments.repository.js';
import * as service from '../../src/modules/user-warehouse-assignments/user-warehouse-assignments.service.js';

vi.mock('../../src/modules/user-warehouse-assignments/user-warehouse-assignments.repository.js');

const fakeDb = {};

describe('user-warehouse-assignments.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('listAssignments', () => {
    it('threads buIds through to the repository filter', async () => {
      repository.findAll.mockResolvedValue([{ id: 1, warehouse_id: 2 }]);
      repository.count.mockResolvedValue(1);

      await service.listAssignments(fakeDb, { page: '1', per_page: '20' }, [13]);

      expect(repository.findAll).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ buIds: [13] }));
      expect(repository.count).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ buIds: [13] }));
    });
  });

  describe('assignUserToWarehouse', () => {
    it('creates the assignment when none exists yet', async () => {
      repository.findByUserAndWarehouse.mockResolvedValue(null);
      repository.create.mockResolvedValue({ id: 1, user_id: 42, warehouse_id: 2, bu_id: 13 });

      const result = await service.assignUserToWarehouse(fakeDb, { user_id: 42, warehouse_id: 2 }, 7);

      expect(repository.create).toHaveBeenCalledWith(fakeDb, {
        user_id: 42,
        warehouse_id: 2,
        assigned_by: 7
      });
      expect(result).toEqual({ data: { id: 1, user_id: 42, warehouse_id: 2, bu_id: 13 } });
    });

    it('throws 409 CONFLICT when the pair already exists', async () => {
      repository.findByUserAndWarehouse.mockResolvedValue({ id: 5 });

      await expect(service.assignUserToWarehouse(fakeDb, { user_id: 42, warehouse_id: 2 })).rejects.toMatchObject({
        statusCode: 409,
        code: 'ASSIGNMENT_EXISTS'
      });
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('unassign', () => {
    it('throws 404 when the assignment does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.unassign(fakeDb, 999, [13])).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND'
      });
    });

    it('removes the assignment when its warehouse bu_id is in scope', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: 13 });

      const result = await service.unassign(fakeDb, 1, [13, 15]);

      expect(repository.remove).toHaveBeenCalledWith(fakeDb, 1);
      expect(result).toEqual({ data: { id: 1 } });
    });

    it('throws 403 for an assignment outside the caller\'s buIds — admin-bu cannot unassign another BU\'s staff', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: 99 });

      await expect(service.unassign(fakeDb, 1, [13])).rejects.toMatchObject({ statusCode: 403 });
      expect(repository.remove).not.toHaveBeenCalled();
    });

    it('allows super-admin (buIds null) to unassign regardless of bu_id', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: 99 });

      const result = await service.unassign(fakeDb, 1, null);

      expect(repository.remove).toHaveBeenCalledWith(fakeDb, 1);
      expect(result).toEqual({ data: { id: 1 } });
    });
  });
});
