import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/modules/activity-logs/activity-logs.repository.js';
import * as service from '../../src/modules/activity-logs/activity-logs.service.js';

vi.mock('../../src/modules/activity-logs/activity-logs.repository.js');

const fakeDb = {};

describe('activity-logs.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('listActivityLogs', () => {
    it('threads buIds through to the repository filter', async () => {
      repository.findAll.mockResolvedValue([{ id: 1, bu_id: 13 }]);
      repository.count.mockResolvedValue(1);

      await service.listActivityLogs(fakeDb, { page: '1', per_page: '20' }, [13, 15]);

      expect(repository.findAll).toHaveBeenCalledWith(
        fakeDb,
        expect.objectContaining({ buIds: [13, 15] }),
        { limit: 20, offset: 0 }
      );
      expect(repository.count).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ buIds: [13, 15] }));
    });

    it('defaults buIds to null (unrestricted) when not passed — super-admin/legacy caller', async () => {
      repository.findAll.mockResolvedValue([]);
      repository.count.mockResolvedValue(0);

      await service.listActivityLogs(fakeDb, {});

      expect(repository.findAll).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ buIds: null }), expect.anything());
    });
  });

  describe('getActivityLog', () => {
    it('throws 404 when the log does not exist', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getActivityLog(fakeDb, 999, [13])).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND'
      });
    });

    it('returns the log when its bu_id is in the caller\'s buIds', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: 13 });

      await expect(service.getActivityLog(fakeDb, 1, [13, 15])).resolves.toEqual({ data: { id: 1, bu_id: 13 } });
    });

    it('throws 404 (not 403) for a log outside the caller\'s buIds — does not reveal it exists', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: 99 });

      await expect(service.getActivityLog(fakeDb, 1, [13])).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND'
      });
    });

    it('throws 404 for a log with bu_id NULL (unassigned) when caller is not super-admin', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: null });

      await expect(service.getActivityLog(fakeDb, 1, [13])).rejects.toMatchObject({ statusCode: 404 });
    });

    it('returns a bu_id-NULL log for super-admin (buIds null — unrestricted)', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: null });

      await expect(service.getActivityLog(fakeDb, 1, null)).resolves.toEqual({ data: { id: 1, bu_id: null } });
    });

    it('returns any log for super-admin regardless of its bu_id', async () => {
      repository.findById.mockResolvedValue({ id: 1, bu_id: 99 });

      await expect(service.getActivityLog(fakeDb, 1, null)).resolves.toEqual({ data: { id: 1, bu_id: 99 } });
    });
  });
});
