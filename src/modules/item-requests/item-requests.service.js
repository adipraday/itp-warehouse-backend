import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { assertRowInScope } from '../../shared/auth/master-data-scope.js';
import { can, INTEGRATION_REQUESTER_ROLE } from '../../shared/auth/role-matrix.js';
import { notifyStakeholders, notifyUsers } from '../../shared/notifications/push.js';
import * as warehousesRepository from '../warehouses/warehouses.repository.js';
import * as repository from './item-requests.repository.js';

export const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS'];

// What the warehouse side may move a request to, from each status. FULFILLED / REJECTED / CANCELLED
// are final.
const TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'FULFILLED', 'REJECTED', 'CANCELLED'],
  IN_PROGRESS: ['FULFILLED', 'REJECTED', 'CANCELLED']
};

const STATUS_LABEL = {
  IN_PROGRESS: 'sedang diproses',
  FULFILLED: 'dipenuhi',
  REJECTED: 'ditolak',
  CANCELLED: 'dibatalkan'
};

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  return error;
}

function inBuScope(buId, buIds) {
  return buIds == null || buIds.map(Number).includes(Number(buId));
}

// An external system (role integration-requester, filed through an auth API key) only ever sees and
// touches the requests IT filed. Everyone else in the BU keeps today's behaviour (the list is shared).
function ownRequestsOnly(ctx) {
  return ctx?.role === INTEGRATION_REQUESTER_ROLE;
}

function isOwnRequest(request, ctx) {
  return request.requested_by != null && Number(request.requested_by) === Number(ctx?.userId);
}

// The form only asks for a description, so a missing subject is taken from its first line.
export function deriveSubject(description) {
  const firstLine =
    String(description)
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '';
  return firstLine.length > 100 ? `${firstLine.slice(0, 97).trimEnd()}...` : firstLine;
}

export async function listItemRequests(db, query, ctx = {}) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    buIds: ctx.buIds ?? null,
    status: query.status ? query.status.split(',').map((s) => s.trim()).filter(Boolean) : null,
    warehouseId: query.warehouse_id ?? null,
    requestedBy: ownRequestsOnly(ctx) ? ctx.userId : query.mine ? ctx.userId : (query.requested_by ?? null),
    source: query.source ?? null,
    externalRef: query.external_ref ?? null,
    q: query.q?.trim() || null
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, filter, { limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getItemRequest(db, id, buIds = null, ctx = null) {
  const request = await repository.findById(db, id);
  if (!request) throw new NotFoundError(`Item request ${id} not found`);
  assertRowInScope(request, buIds, 'item request');
  // 404, not 403: an external system must not learn that someone else's request exists.
  if (ownRequestsOnly(ctx) && !isOwnRequest(request, ctx)) throw new NotFoundError(`Item request ${id} not found`);
  return { data: request };
}

// Which business unit a new request belongs to: the addressed warehouse's, else an explicit bu_id the
// caller is allowed to use, else the caller's own. Super-admin has no home BU, so must say which.
async function resolveTarget(db, body, ctx) {
  if (body.warehouse_id != null) {
    const warehouse = await warehousesRepository.findById(db, body.warehouse_id);
    if (!warehouse) throw new NotFoundError(`Warehouse ${body.warehouse_id} not found`);
    if (!inBuScope(warehouse.bu_id, ctx.buIds)) {
      throw forbidden(`warehouse ${warehouse.id} is outside your business unit`);
    }
    if (body.bu_id != null && Number(body.bu_id) !== Number(warehouse.bu_id)) {
      throw new BadRequestError('BU_WAREHOUSE_MISMATCH', 'warehouse_id does not belong to bu_id');
    }
    return { buId: Number(warehouse.bu_id), warehouseId: Number(warehouse.id) };
  }

  let buId;
  if (ctx.buIds == null) {
    buId = body.bu_id ?? null;
  } else if (body.bu_id != null && inBuScope(body.bu_id, ctx.buIds)) {
    buId = Number(body.bu_id);
  } else {
    buId = ctx.buId ?? null;
  }
  if (buId == null) throw new BadRequestError('BU_REQUIRED', 'bu_id is required');
  return { buId, warehouseId: null };
}

async function notifyNewRequest(db, request) {
  try {
    const who = request.requester_name ? `${request.requester_name}: ` : '';
    await notifyStakeholders(db, {
      buId: request.bu_id,
      // Addressed to a warehouse: its admin and staff. Otherwise the BU's warehouse roles are told.
      ...(request.warehouse_id != null
        ? { warehouseId: request.warehouse_id, warehouseRoles: ['admin-warehouse', 'staff-gudang'] }
        : { extraBuRoles: ['admin-warehouse', 'staff-gudang'] }),
      title: 'Permintaan Barang Baru',
      body: `${who}${request.subject}`,
      data: { type: 'item_request', id: request.id }
    });
  } catch (error) {
    console.warn('[push] item request notification failed', { id: request.id, error: error.message });
  }
}

// The same external_ref again means "this is a retry": hand back the earlier request. But for an
// external system an external_ref already used by SOMEONE ELSE in the BU must not return their request.
function duplicateResult(existing, ctx) {
  if (ownRequestsOnly(ctx) && !isOwnRequest(existing, ctx)) {
    throw new ConflictError('EXTERNAL_REF_TAKEN', 'external_ref is already used by another requester in this business unit');
  }
  return { statusCode: 200, body: { data: existing, meta: { duplicate: true } } };
}

// Returns { statusCode, body }: 201 for a new request, 200 when the caller's external_ref already
// exists (the same POST can be retried safely — it returns the earlier request, never a second one).
export async function createItemRequest(db, body, ctx = {}) {
  const { buId, warehouseId } = await resolveTarget(db, body, ctx);
  const externalRef = body.external_ref?.trim() || null;

  if (externalRef) {
    const existing = await repository.findByExternalRef(db, buId, externalRef);
    if (existing) return duplicateResult(existing, ctx);
  }

  const payload = {
    bu_id: buId,
    warehouse_id: warehouseId,
    requested_by: ctx.userId ?? null,
    requester_name: body.requester_name?.trim() || null,
    subject: body.subject?.trim() || deriveSubject(body.description),
    description: body.description.trim(),
    source: body.source?.trim() || 'app',
    external_ref: externalRef
  };

  let request;
  try {
    request = await repository.create(db, payload);
  } catch (error) {
    // Two identical POSTs racing past the check above: the unique key lets one win, the other
    // returns it.
    if (externalRef && error.code === 'ER_DUP_ENTRY') {
      const existing = await repository.findByExternalRef(db, buId, externalRef);
      if (existing) return duplicateResult(existing, ctx);
    }
    throw error;
  }

  await notifyNewRequest(db, request);
  return { statusCode: 201, body: { data: request } };
}

// A warehouse admin / staff member is tied to their assigned warehouses: a request addressed to
// another warehouse is not theirs to work on. A request addressed to no warehouse, or any request
// for admin-bu / super-admin (no assignment list), is open to every handler in the BU.
function assertMayHandle(request, ctx) {
  const assigned = ctx.assignedWarehouseIds ?? null;
  if (assigned == null || request.warehouse_id == null) return;
  if (!assigned.map(Number).includes(Number(request.warehouse_id))) {
    throw forbidden(`item request ${request.id} is addressed to a warehouse you are not assigned to`);
  }
}

async function transition(db, id, { status, note, ctx, fromStatuses }) {
  const ok = await repository.updateStatus(db, id, {
    status,
    responseNote: note,
    handledBy: ctx.userId ?? null,
    fromStatuses
  });
  if (!ok) {
    throw new ConflictError('INVALID_STATUS_TRANSITION', `The request can no longer be changed to ${status}`);
  }
  return repository.findById(db, id);
}

async function notifyRequester(db, request, ctx) {
  if (request.requested_by == null || Number(request.requested_by) === Number(ctx.userId)) return;
  try {
    const note = request.response_note ? ` Catatan: ${request.response_note}` : '';
    await notifyUsers(db, {
      userIds: [Number(request.requested_by)],
      title: 'Permintaan Barang Diperbarui',
      body: `Permintaan ${request.request_number} (${request.subject}) ${STATUS_LABEL[request.status] ?? request.status}.${note}`,
      data: { type: 'item_request', id: request.id }
    });
  } catch (error) {
    console.warn('[push] item request status notification failed', { id: request.id, error: error.message });
  }
}

// Warehouse side: OPEN -> IN_PROGRESS -> FULFILLED, or REJECTED (a reason is required). Cancelling
// goes through cancelItemRequest, which the requester may also use.
export async function changeItemRequestStatus(db, id, { status, note = null }, ctx = {}) {
  const request = await repository.findById(db, id);
  if (!request) throw new NotFoundError(`Item request ${id} not found`);
  assertRowInScope(request, ctx.buIds ?? null, 'item request');
  assertMayHandle(request, ctx);

  const allowed = TRANSITIONS[request.status] ?? [];
  if (!allowed.includes(status)) {
    throw new ConflictError(
      'INVALID_STATUS_TRANSITION',
      `A request that is ${request.status} cannot be changed to ${status}`
    );
  }
  const cleanNote = note?.trim() || null;
  if (status === 'REJECTED' && !cleanNote) {
    throw new BadRequestError('RESPONSE_NOTE_REQUIRED', 'A note explaining the rejection is required');
  }

  const updated = await transition(db, id, { status, note: cleanNote, ctx, fromStatuses: [request.status] });
  await notifyRequester(db, updated, ctx);
  return { data: updated };
}

// The requester can withdraw their own request while nobody has started on it; a handler (admin-bu,
// admin-warehouse, staff-gudang) can cancel any open request in their scope.
export async function cancelItemRequest(db, id, { note = null } = {}, ctx = {}) {
  const request = await repository.findById(db, id);
  if (!request) throw new NotFoundError(`Item request ${id} not found`);
  assertRowInScope(request, ctx.buIds ?? null, 'item request');
  if (ownRequestsOnly(ctx) && !isOwnRequest(request, ctx)) throw new NotFoundError(`Item request ${id} not found`);

  const isRequester = request.requested_by != null && Number(request.requested_by) === Number(ctx.userId);
  const isHandler = can(ctx.role, 'item-requests', 'handle');
  if (!isRequester && !isHandler) throw forbidden('Only the requester or the warehouse may cancel this request');
  if (isHandler && !isRequester) assertMayHandle(request, ctx);

  const fromStatuses = isHandler ? OPEN_STATUSES : ['OPEN'];
  if (!fromStatuses.includes(request.status)) {
    throw new ConflictError('INVALID_STATUS_TRANSITION', `A request that is ${request.status} cannot be cancelled`);
  }

  const updated = await transition(db, id, {
    status: 'CANCELLED',
    note: note?.trim() || null,
    ctx,
    fromStatuses
  });
  // Only the warehouse cancelling needs to tell the requester; a requester withdrawing needs no echo.
  if (!isRequester) await notifyRequester(db, updated, ctx);
  return { data: updated };
}
