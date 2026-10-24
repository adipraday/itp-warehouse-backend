import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import * as repository from '../../src/modules/item-requests/item-requests.repository.js';
import * as warehousesRepository from '../../src/modules/warehouses/warehouses.repository.js';
import * as service from '../../src/modules/item-requests/item-requests.service.js';
import { itemRequestsRoutes } from '../../src/modules/item-requests/item-requests.routes.js';
import { notifyStakeholders, notifyUsers } from '../../src/shared/notifications/push.js';
import { can } from '../../src/shared/auth/role-matrix.js';

vi.mock('../../src/modules/item-requests/item-requests.repository.js');
vi.mock('../../src/modules/warehouses/warehouses.repository.js');
vi.mock('../../src/shared/notifications/push.js', () => ({
  notifyStakeholders: vi.fn(async () => {}),
  notifyUsers: vi.fn(async () => {})
}));

const db = {};
const staff = { userId: 7, role: 'kasir-sales', buId: 3, buIds: [3] };
const warehouseAdmin = { userId: 20, role: 'admin-warehouse', buId: 3, buIds: [3], assignedWarehouseIds: [9] };

function row(overrides = {}) {
  return {
    id: 1,
    request_number: 'REQ-000001',
    bu_id: 3,
    warehouse_id: null,
    requested_by: 7,
    requester_name: 'Budi',
    subject: 'Kardus',
    description: 'Butuh kardus',
    status: 'OPEN',
    response_note: null,
    ...overrides
  };
}

describe('item-requests.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    notifyStakeholders.mockResolvedValue();
    notifyUsers.mockResolvedValue();
  });

  describe('deriveSubject', () => {
    it('uses the first non-empty line, collapsed', () => {
      expect(service.deriveSubject('\n  Butuh   kardus L \nuntuk acara')).toBe('Butuh kardus L');
    });

    it('cuts a long first line at 100 characters', () => {
      const subject = service.deriveSubject('x'.repeat(300));
      expect(subject).toHaveLength(100);
      expect(subject.endsWith('...')).toBe(true);
    });
  });

  describe('createItemRequest', () => {
    it('needs only a description: the subject comes from it and the BU from the caller', async () => {
      repository.create.mockImplementation(async (_db, data) => row({ ...data, id: 5 }));

      const result = await service.createItemRequest(db, { description: 'Butuh 20 dus kardus\nuntuk Jumat' }, staff);

      expect(result.statusCode).toBe(201);
      expect(repository.create).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          bu_id: 3,
          warehouse_id: null,
          requested_by: 7,
          subject: 'Butuh 20 dus kardus',
          description: 'Butuh 20 dus kardus\nuntuk Jumat',
          source: 'app',
          external_ref: null
        })
      );
      // Not addressed to a warehouse: the BU's warehouse roles are told.
      expect(notifyStakeholders).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ buId: 3, extraBuRoles: ['admin-warehouse', 'staff-gudang'] })
      );
    });

    it('takes the BU from the addressed warehouse and tells that warehouse', async () => {
      warehousesRepository.findById.mockResolvedValue({ id: 9, bu_id: 3 });
      repository.create.mockImplementation(async (_db, data) => row({ ...data, id: 6 }));

      await service.createItemRequest(db, { description: 'x', warehouse_id: 9 }, staff);

      expect(repository.create).toHaveBeenCalledWith(db, expect.objectContaining({ bu_id: 3, warehouse_id: 9 }));
      expect(notifyStakeholders).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ warehouseId: 9, warehouseRoles: ['admin-warehouse', 'staff-gudang'] })
      );
    });

    it('rejects a warehouse outside the caller business unit', async () => {
      warehousesRepository.findById.mockResolvedValue({ id: 9, bu_id: 4 });

      await expect(service.createItemRequest(db, { description: 'x', warehouse_id: 9 }, staff)).rejects.toMatchObject({
        statusCode: 403
      });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a warehouse that does not belong to the stated bu_id', async () => {
      warehousesRepository.findById.mockResolvedValue({ id: 9, bu_id: 3 });
      const admin = { userId: 1, role: 'super-admin', buId: null, buIds: null };

      await expect(
        service.createItemRequest(db, { description: 'x', warehouse_id: 9, bu_id: 4 }, admin)
      ).rejects.toMatchObject({ code: 'BU_WAREHOUSE_MISMATCH' });
    });

    it('asks a super-admin (no home BU) to name the BU', async () => {
      const admin = { userId: 1, role: 'super-admin', buId: null, buIds: null };

      await expect(service.createItemRequest(db, { description: 'x' }, admin)).rejects.toMatchObject({
        code: 'BU_REQUIRED'
      });
    });

    it('ignores a bu_id the caller has no access to', async () => {
      repository.create.mockImplementation(async (_db, data) => row({ ...data }));

      await service.createItemRequest(db, { description: 'x', bu_id: 99 }, staff);

      expect(repository.create).toHaveBeenCalledWith(db, expect.objectContaining({ bu_id: 3 }));
    });

    it('returns the earlier request when the external_ref was already used (retry-safe)', async () => {
      repository.findByExternalRef.mockResolvedValue(row({ id: 2, external_ref: 'ERP-1' }));

      const result = await service.createItemRequest(
        db,
        { description: 'x', external_ref: 'ERP-1', source: 'erp' },
        staff
      );

      expect(result).toEqual({
        statusCode: 200,
        body: { data: expect.objectContaining({ id: 2 }), meta: { duplicate: true } }
      });
      expect(repository.create).not.toHaveBeenCalled();
      expect(notifyStakeholders).not.toHaveBeenCalled();
    });

    it('also returns the existing request when two identical POSTs race', async () => {
      repository.findByExternalRef.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: 2 }));
      repository.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));

      const result = await service.createItemRequest(db, { description: 'x', external_ref: 'ERP-1' }, staff);

      expect(result.statusCode).toBe(200);
      expect(result.body.meta).toEqual({ duplicate: true });
    });

    it('keeps the request when notifying fails', async () => {
      repository.create.mockImplementation(async (_db, data) => row({ ...data }));
      notifyStakeholders.mockRejectedValue(new Error('fcm down'));

      const result = await service.createItemRequest(db, { description: 'x' }, staff);

      expect(result.statusCode).toBe(201);
    });
  });

  describe('listItemRequests', () => {
    it('scopes to the caller BUs and parses the status list', async () => {
      repository.findAll.mockResolvedValue([]);
      repository.count.mockResolvedValue(0);

      await service.listItemRequests(db, { status: 'OPEN, IN_PROGRESS', mine: true }, staff);

      expect(repository.findAll).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ buIds: [3], status: ['OPEN', 'IN_PROGRESS'], requestedBy: 7 }),
        { limit: 20, offset: 0 }
      );
    });
  });

  describe('getItemRequest', () => {
    it('404s for an unknown request and 403s for another business unit', async () => {
      repository.findById.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ bu_id: 4 }));

      await expect(service.getItemRequest(db, 1, [3])).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.getItemRequest(db, 1, [3])).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('changeItemRequestStatus', () => {
    it('moves OPEN to IN_PROGRESS and tells the requester', async () => {
      repository.findById
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ status: 'IN_PROGRESS' }));
      repository.updateStatus.mockResolvedValue(true);

      const result = await service.changeItemRequestStatus(db, 1, { status: 'IN_PROGRESS' }, warehouseAdmin);

      expect(result.data.status).toBe('IN_PROGRESS');
      expect(repository.updateStatus).toHaveBeenCalledWith(
        db,
        1,
        expect.objectContaining({ status: 'IN_PROGRESS', handledBy: 20, fromStatuses: ['OPEN'] })
      );
      expect(notifyUsers).toHaveBeenCalledWith(db, expect.objectContaining({ userIds: [7] }));
    });

    it('requires a note to reject', async () => {
      repository.findById.mockResolvedValue(row());

      await expect(
        service.changeItemRequestStatus(db, 1, { status: 'REJECTED', note: '  ' }, warehouseAdmin)
      ).rejects.toMatchObject({ code: 'RESPONSE_NOTE_REQUIRED' });
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('does not reopen a finished request', async () => {
      repository.findById.mockResolvedValue(row({ status: 'FULFILLED' }));

      await expect(
        service.changeItemRequestStatus(db, 1, { status: 'IN_PROGRESS' }, warehouseAdmin)
      ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS_TRANSITION' });
    });

    it('answers 409 when someone else changed the request first', async () => {
      repository.findById.mockResolvedValue(row());
      repository.updateStatus.mockResolvedValue(false);

      await expect(
        service.changeItemRequestStatus(db, 1, { status: 'FULFILLED' }, warehouseAdmin)
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('keeps an admin-warehouse out of a request addressed to a warehouse they are not assigned to', async () => {
      repository.findById.mockResolvedValue(row({ warehouse_id: 10 }));

      await expect(
        service.changeItemRequestStatus(db, 1, { status: 'FULFILLED' }, warehouseAdmin)
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('lets them work on a request addressed to their own warehouse', async () => {
      repository.findById
        .mockResolvedValueOnce(row({ warehouse_id: 9 }))
        .mockResolvedValueOnce(row({ warehouse_id: 9, status: 'FULFILLED' }));
      repository.updateStatus.mockResolvedValue(true);

      const result = await service.changeItemRequestStatus(db, 1, { status: 'FULFILLED' }, warehouseAdmin);

      expect(result.data.status).toBe('FULFILLED');
    });

    it('does not notify a requester who is also the one acting', async () => {
      repository.findById
        .mockResolvedValueOnce(row({ requested_by: 20 }))
        .mockResolvedValueOnce(row({ requested_by: 20, status: 'FULFILLED' }));
      repository.updateStatus.mockResolvedValue(true);

      await service.changeItemRequestStatus(db, 1, { status: 'FULFILLED' }, warehouseAdmin);

      expect(notifyUsers).not.toHaveBeenCalled();
    });
  });

  describe('cancelItemRequest', () => {
    it('lets the requester withdraw their own OPEN request, without a notification', async () => {
      repository.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: 'CANCELLED' }));
      repository.updateStatus.mockResolvedValue(true);

      const result = await service.cancelItemRequest(db, 1, {}, staff);

      expect(result.data.status).toBe('CANCELLED');
      expect(repository.updateStatus).toHaveBeenCalledWith(db, 1, expect.objectContaining({ fromStatuses: ['OPEN'] }));
      expect(notifyUsers).not.toHaveBeenCalled();
    });

    it('does not let the requester pull a request the warehouse already started', async () => {
      repository.findById.mockResolvedValue(row({ status: 'IN_PROGRESS' }));

      await expect(service.cancelItemRequest(db, 1, {}, staff)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('does not let another user cancel someone else request', async () => {
      repository.findById.mockResolvedValue(row({ requested_by: 99 }));

      await expect(service.cancelItemRequest(db, 1, {}, staff)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('lets the warehouse cancel an in-progress request and tells the requester', async () => {
      repository.findById
        .mockResolvedValueOnce(row({ status: 'IN_PROGRESS' }))
        .mockResolvedValueOnce(row({ status: 'CANCELLED' }));
      repository.updateStatus.mockResolvedValue(true);

      await service.cancelItemRequest(db, 1, { note: 'stok kosong' }, warehouseAdmin);

      expect(repository.updateStatus).toHaveBeenCalledWith(
        db,
        1,
        expect.objectContaining({ responseNote: 'stok kosong', fromStatuses: ['OPEN', 'IN_PROGRESS'] })
      );
      expect(notifyUsers).toHaveBeenCalled();
    });
  });
});

describe('item-requests routes and role matrix', () => {
  it('registers the list, detail, create, status and cancel routes', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', {});
    app.decorateRequest('userContext', null);
    await app.register(itemRequestsRoutes, { prefix: '/api/item-requests' });
    await app.ready();

    for (const [method, url] of [
      ['GET', '/api/item-requests'],
      ['GET', '/api/item-requests/:id'],
      ['POST', '/api/item-requests'],
      ['POST', '/api/item-requests/:id/status'],
      ['POST', '/api/item-requests/:id/cancel']
    ]) {
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    await app.close();
  });

  it('every working role may file a request, only the warehouse side handles it, owner is view-only', () => {
    for (const role of ['admin-bu', 'admin-warehouse', 'staff-gudang', 'kasir-sales', 'purchasing', 'finance']) {
      expect(can(role, 'item-requests', 'write'), role).toBe(true);
    }
    expect(can('staff-gudang', 'item-requests', 'handle')).toBe(true);
    expect(can('admin-warehouse', 'item-requests', 'handle')).toBe(true);
    expect(can('admin-bu', 'item-requests', 'handle')).toBe(true);
    expect(can('kasir-sales', 'item-requests', 'handle')).toBe(false);
    expect(can('purchasing', 'item-requests', 'handle')).toBe(false);
    expect(can('owner', 'item-requests', 'write')).toBe(false);
    expect(can('owner', 'item-requests', 'handle')).toBe(false);
  });
});
