// Resolves/validates business units against the auth-backend over the trusted
// X-Service-Key channel (no user token needed) — see the businessUnitRouter's
// serviceKeyOrAuthorize() in the auth-backend for the other side of this contract.
//
// WHY THIS EXISTS: business_units.id is auto-increment in the auth-backend's own
// database and shifts every time auth_db is reseeded. warehouse-backend must never
// hardcode or assume a bu_id number stays stable across environments/resets — that
// exact mistake caused a real incident (docs/bug-report-bu-id-mismatch.md, 2026-09-06):
// warehouses ended up with a bu_id that no longer matched any real business unit,
// silently locking every non-super-admin user of that BU out of their own data.
// This module is the fix — always resolve by `code` (stable, human-chosen) or
// validate an `id` against the auth-backend before trusting it, never assume.

function serviceUnavailable(cause) {
  const error = new Error('Could not reach the auth service to validate the business unit');
  error.statusCode = 502;
  error.code = 'BUSINESS_UNIT_SERVICE_UNAVAILABLE';
  error.cause = cause;
  return error;
}

async function callAuthBackend(config, path) {
  const url = `${config.AUTH_API_URL}${path}`;
  let response;
  try {
    response = await fetch(url, { headers: { 'X-Service-Key': config.SERVICE_API_KEY } });
  } catch (cause) {
    throw serviceUnavailable(cause);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw serviceUnavailable(new Error(`auth-backend GET ${path} returned ${response.status}`));
  }
  return response.json();
}

// Returns the business unit { id, name, code, status, ... } or null if it doesn't exist.
export async function getBusinessUnitById(config, id) {
  const body = await callAuthBackend(config, `/business-units/${id}`);
  return body?.data?.business_unit ?? null;
}

// Returns the business unit for an exact `code` match, or null if none exists.
export async function findBusinessUnitByCode(config, code) {
  const body = await callAuthBackend(config, `/business-units?code=${encodeURIComponent(code)}`);
  return body?.data?.business_units?.[0] ?? null;
}

// Throws BadRequestError-shaped errors (statusCode/code set directly, same shape
// shared/errors/app-error.js produces) if `buId` isn't a real, ACTIVE business unit.
// No-op for `buId == null` (unassigned is always valid — only super-admin may set
// a warehouse's bu_id to null, enforced elsewhere).
export async function assertBusinessUnitIsUsable(config, buId) {
  if (buId == null) return;

  const bu = await getBusinessUnitById(config, buId);
  if (!bu) {
    const error = new Error(`Business unit ${buId} does not exist`);
    error.statusCode = 400;
    error.code = 'INVALID_BUSINESS_UNIT';
    throw error;
  }
  if (bu.status !== 'ACTIVE') {
    const error = new Error(`Business unit ${buId} is not ACTIVE (status: ${bu.status})`);
    error.statusCode = 400;
    error.code = 'INVALID_BUSINESS_UNIT';
    throw error;
  }
}
