import * as activityLogsRepository from '../../modules/activity-logs/activity-logs.repository.js';

const RESOURCE_TO_ENTITY = {
  warehouses: 'WAREHOUSE',
  items: 'ITEM',
  contacts: 'CONTACT',
  inbounds: 'INBOUND',
  outbounds: 'OUTBOUND',
  'stock-transfers': 'STOCK_TRANSFER',
  'stock-opnames': 'STOCK_OPNAME',
  sales: 'SALE',
  purchases: 'PURCHASE',
  payments: 'PAYMENT',
  returns: 'RETURN'
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// The acting user's token identifies a business unit, not a single warehouse
// (one BU has many warehouses). The warehouse an action touched comes from the
// request itself.
function warehouseIdFromRequest(request) {
  const candidate =
    request.query?.warehouse_id ??
    request.body?.warehouse_id ??
    request.body?.source_warehouse_id ??
    request.body?.destination_warehouse_id ??
    null;
  const n = Number(candidate);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Which BU this log entry belongs to, for later scoping (activity-logs has no
// tables.sql column to join through like every other module — it has to be
// captured at write time instead). Prefer the BU that OWNS the warehouse the
// action actually touched (a grant/owner acting on a non-home BU should file
// under that BU, not their own); fall back to the actor's home BU when no
// warehouse was named in the request at all (e.g. GET-adjacent mutations with
// no warehouse_id, or the warehouse lookup comes back empty).
async function resolveBuId(app, request, warehouseId) {
  const homeBuId = request.userContext?.buId ?? null;
  if (!warehouseId) return homeBuId;
  const [rows] = await app.db.execute('SELECT bu_id FROM warehouses WHERE id = ?', [warehouseId]);
  return rows[0]?.bu_id ?? homeBuId;
}

// Derives {action, entityType, entityId} from the URL/method alone, so every
// module gets activity logging for free without a per-service call site.
function describeActivity(request, payload) {
  const segments = request.url.split('?')[0].split('/').filter(Boolean);
  segments.shift(); // drop leading 'api'

  const resource = segments[0];
  const entityType = RESOURCE_TO_ENTITY[resource];
  if (!entityType) return null;

  const idSegment = segments[1];
  const subaction = segments[2];

  let action;
  if (subaction) {
    action = subaction.toUpperCase();
  } else if (request.method === 'POST') {
    action = 'CREATE';
  } else if (request.method === 'PUT') {
    action = 'UPDATE';
  } else if (request.method === 'DELETE') {
    action = 'DELETE';
  } else {
    return null;
  }

  let entityId = /^\d+$/.test(idSegment ?? '') ? Number(idSegment) : null;
  if (entityId === null) {
    try {
      entityId = JSON.parse(payload)?.data?.id ?? null;
    } catch {
      entityId = null;
    }
  }

  return { action, entityType, entityId };
}

// Fires after every successful mutating /api/* request. Never throws: a
// logging failure must never affect the real API response.
export async function registerActivityLog(app) {
  app.addHook('onSend', async (request, reply, payload) => {
    try {
      if (!request.url.startsWith('/api/')) return payload;
      if (!MUTATING_METHODS.has(request.method)) return payload;
      if (reply.statusCode >= 400) return payload;

      const described = describeActivity(request, payload);
      if (!described) return payload;

      const warehouseId = warehouseIdFromRequest(request);
      const buId = await resolveBuId(app, request, warehouseId);

      await activityLogsRepository.create(app.db, {
        user_id: request.userContext?.userId ?? null,
        warehouse_id: warehouseId,
        bu_id: buId,
        action: described.action,
        entity_type: described.entityType,
        entity_id: described.entityId,
        method: request.method,
        endpoint: request.url,
        status_code: reply.statusCode
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to write activity log');
    }

    return payload;
  });
}
