import { getMessaging } from './firebase-admin.js';
import * as deviceTokensRepository from '../../modules/device-tokens/device-tokens.repository.js';
import * as notificationsRepository from '../../modules/notifications/notifications.repository.js';
import * as userDirectoryRepository from '../../modules/user-directory/user-directory.repository.js';

const DEAD_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

// Two independent recipient sets feed one notification:
//   - tokenRecipients: [{user_id, fcm_token}] from device_tokens — the only
//     people who get the FCM push (a push needs a device).
//   - directoryUserIds: user_ids from user_directory (role/BU/warehouse match,
//     no device needed) — so a user who only ever uses the web app still gets
//     the inbox row. Added 2026-10-05; before it, the inbox was token-only.
// Every targeted user gets exactly one inbox row (see
// notifications.repository.js), deduped by user_id across BOTH sets and across
// multiple devices. This write happens regardless of whether FCM is configured
// or the send below succeeds, so the in-app inbox works even with Firebase
// unset or down.
async function deliver(db, { tokenRecipients, directoryUserIds }, { title, body, data = {}, type = 'general' }) {
  const userIds = [...new Set([...tokenRecipients.map((r) => r.user_id), ...directoryUserIds])];
  if (userIds.length === 0) return;

  await notificationsRepository.createForUsers(db, userIds, { title, body, type, data });

  const messaging = getMessaging();
  if (!messaging || tokenRecipients.length === 0) return;

  const tokens = tokenRecipients.map((r) => r.fcm_token);
  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    // FCM data payloads must be string-only values.
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
    android: { priority: 'high' }
  });

  const deadTokens = [];
  response.responses.forEach((result, index) => {
    if (!result.success && DEAD_TOKEN_ERROR_CODES.has(result.error?.code)) {
      deadTokens.push(tokens[index]);
    }
  });
  if (deadTokens.length > 0) {
    await deviceTokensRepository.removeTokens(db, deadTokens);
  }
}

// The directory lookup is an add-on to the original token path, so a failure
// there (e.g. the user_directory migration not applied yet during a deploy)
// must degrade to "token recipients only" — never take the FCM push down too.
async function lookupDirectory(lookup) {
  try {
    return await lookup();
  } catch (error) {
    console.warn('[push] user_directory lookup failed', { error: error.message });
    return [];
  }
}

// Best-effort, always — a push-sending hiccup (FCM down, a malformed
// payload, a DB blip looking up tokens) must never fail the business
// operation that triggered it (e.g. submitting a stock opname), so every
// exported function's body is one big try/catch with no rethrow.
//
// For a BU-scoped role (admin-bu, admin-warehouse, purchasing, finance,
// kasir-sales, staff-gudang) — requires a buId, since that's how the
// relevant device tokens are filtered. For a role that ISN'T BU-scoped
// (owner oversees a whole company's worth of BUs, not just one), use
// [notifyAllWithRole] instead — passing a single buId here would silently
// match nothing, since that role's tokens are stored with bu_id NULL.
export async function notifyRole(db, { role, buId, title, body, data = {} }) {
  try {
    if (buId == null) return;
    const [tokenRecipients, directoryUserIds] = await Promise.all([
      deviceTokensRepository.findTokensForRoleAndBu(db, role, buId),
      lookupDirectory(() => userDirectoryRepository.findUserIdsForRoleAndBu(db, role, buId))
    ]);
    await deliver(db, { tokenRecipients, directoryUserIds }, { title, body, data, type: data.type });
  } catch (error) {
    console.warn('[push] notifyRole failed', { role, buId, error: error.message });
  }
}

// For roles that aren't BU-scoped — notifies every registered device for
// that role, regardless of bu_id.
//
// `buId` (optional) narrows BOTH the device-token side and the user_directory
// side to users whose verified token covers that BU — an owner's token lists
// every BU of their own company, so this keeps one company's owners (inbox AND
// push) out of another company's events. Without a buId the role-wide
// behaviour is unchanged. A device whose owner isn't in user_directory yet is
// left out until their next authenticated request (see
// device-tokens.repository.findTokensForRole).
export async function notifyAllWithRole(db, { role, buId = null, title, body, data = {} }) {
  try {
    const [tokenRecipients, directoryUserIds] = await Promise.all([
      deviceTokensRepository.findTokensForRole(db, role, buId),
      lookupDirectory(() => userDirectoryRepository.findUserIdsForRole(db, role, buId))
    ]);
    await deliver(db, { tokenRecipients, directoryUserIds }, { title, body, data, type: data.type });
  } catch (error) {
    console.warn('[push] notifyAllWithRole failed', { role, error: error.message });
  }
}

// The roles that can be scoped to one assigned warehouse at a time (not
// BU-wide) — the full set used for "notify everyone working at this
// warehouse" (inbound/outbound/sale completion). Individual call sites may
// pass a narrower subset (e.g. just ['admin-warehouse']).
export const WAREHOUSE_STAFF_ROLES = ['admin-warehouse', 'staff-gudang', 'kasir-sales', 'purchasing'];

// For specific role(s) assigned to a specific warehouse — e.g. "an inbound
// just completed at warehouse X, tell the admin-warehouse and staff-gudang
// who work there", not BU-wide and not admin-bu/owner.
export async function notifyWarehouseRoles(db, { warehouseId, roles, title, body, data = {} }) {
  try {
    if (warehouseId == null || roles.length === 0) return;
    const [tokenRecipients, directoryUserIds] = await Promise.all([
      deviceTokensRepository.findTokensForWarehouseStaff(db, warehouseId, roles),
      lookupDirectory(() => userDirectoryRepository.findUserIdsForWarehouseStaff(db, warehouseId, roles))
    ]);
    await deliver(db, { tokenRecipients, directoryUserIds }, { title, body, data, type: data.type });
  } catch (error) {
    console.warn('[push] notifyWarehouseRoles failed', { warehouseId, roles, error: error.message });
  }
}

// Convenience wrapper for the common combo used by most notification types
// in this app: admin-bu (BU-wide, always included) + optionally owner
// (company-wide) + optionally specific role(s) scoped to one warehouse.
// Each piece best-effort on its own (see the functions above) — a failure
// in one never blocks the others.
export async function notifyStakeholders(db, {
  buId,
  extraBuRoles = [],
  includeOwner = false,
  warehouseId = null,
  warehouseRoles = [],
  title,
  body,
  data = {}
}) {
  const tasks = [notifyRole(db, { role: 'admin-bu', buId, title, body, data })];
  for (const role of extraBuRoles) {
    tasks.push(notifyRole(db, { role, buId, title, body, data }));
  }
  if (includeOwner) {
    tasks.push(notifyAllWithRole(db, { role: 'owner', buId, title, body, data }));
  }
  if (warehouseId != null && warehouseRoles.length > 0) {
    tasks.push(notifyWarehouseRoles(db, { warehouseId, roles: warehouseRoles, title, body, data }));
  }
  await Promise.all(tasks);
}
