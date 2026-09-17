import { createRemoteJWKSet, jwtVerify } from 'jose';

// Verifies the auth backend's RS256 access token via its JWKS endpoint and
// populates request.userContext: { userId, role, buId, buIds }.
//
// buId = the user's home business unit (admin-bu/staff) — kept for provisioning
// purposes (who's allowed to grant/manage what), NOT for access checks anymore.
// buId === null means super-admin.
//
// buIds = the actual authorization scope since the multi-tenant rollout
// (docs/auth-multitenant-coordination.md §7, 2026-09-08): every BU the caller
// may access — home BU + any admin-bu grants, or every BU in an owner's company.
// null = unrestricted (super-admin). This is what buScope()/list filters check now.
//
// AUTH_MODE controls the rollout:
//   'jwt'    - Authorization: Bearer <token> is the only accepted source; a
//              present-but-invalid/expired token is rejected with 401, and any
//              /api/* request without a valid token is rejected with 401
//              (except PUBLIC_PATHS).
//   'header' - legacy X-User-Id / X-User-Role / X-Bu-Id headers only (pre-JWT),
//              useful for local testing without the auth backend.
//   'hybrid' - tries the bearer token first, falls back to the legacy headers
//              if no token was sent or verification failed. No request is rejected
//              for missing identity. Transition window only.
const PUBLIC_PATHS = [/^\/health$/, /^\/documentation(\/|$)/, /^\/$/];

function isPublicPath(url) {
  const path = url.split('?')[0];
  return PUBLIC_PATHS.some((re) => re.test(path));
}

function unauthorized(message) {
  const error = new Error(message);
  error.statusCode = 401;
  error.code = 'UNAUTHORIZED';
  return error;
}

// The legacy header path has no concept of multi-BU grants — a single X-Bu-Id
// is both the home BU and the entire authorization scope, same as buId always
// was before bu_ids existed.
function contextFromHeaders(request) {
  const rawUserId = request.headers['x-user-id'];
  const rawBuId = request.headers['x-bu-id'] ?? request.headers['x-warehouse-id']; // accept old header name
  const buId = rawBuId ? Number(rawBuId) : null;
  return {
    userId: rawUserId ? Number(rawUserId) : null,
    role: request.headers['x-user-role'] ?? null,
    buId,
    buIds: buId == null ? null : [buId]
  };
}

// bu_ids is the new claim (2026-09-08). Three cases:
//   - explicit `null` in the token  -> unrestricted (super-admin's convention)
//   - an array                       -> exactly that (home BU(s) + grants, per auth-backend)
//   - the claim is simply absent     -> an older-style token still within its TTL
//     during rollout, or a re-verified payload some other caller built by hand.
//     Fail-safe to exactly the single bu_id the caller already had — never wider
//     than before (B3, docs/auth-multitenant-coordination.md §2.b) — rather than
//     guessing "no claim" means "unrestricted".
function resolveBuIds(payload, buId) {
  if (payload.bu_ids === null) return null;
  if (Array.isArray(payload.bu_ids)) return payload.bu_ids.map(Number);
  return buId == null ? null : [buId];
}

export async function registerUserContext(app) {
  const mode = app.config.AUTH_MODE;
  // Lazy/cached: does not fetch the JWKS at startup, only on first verification
  // that needs a matching kid, so the server still boots if the auth backend is down.
  const jwks = mode !== 'header' ? createRemoteJWKSet(new URL(app.config.AUTH_JWKS_URL)) : null;

  // onRequest (not preHandler): auth must run before body parsing & schema
  // validation, so an unauthenticated request gets 401 rather than a 400 for a
  // malformed body it was never allowed to send.
  app.addHook('onRequest', async (request) => {
    let context = null;
    let tokenPresent = false;

    if (jwks) {
      const authorization = request.headers.authorization ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;

      if (token) {
        tokenPresent = true;
        try {
          const { payload } = await jwtVerify(token, jwks, {
            algorithms: ['RS256'],
            issuer: app.config.AUTH_JWT_ISSUER,
            audience: app.config.AUTH_JWT_AUDIENCE,
            clockTolerance: 30
          });
          const buId = payload.bu_id == null ? null : Number(payload.bu_id);
          context = {
            userId: Number(payload.user_id ?? payload.sub),
            role: payload.role ?? null,
            buId,
            buIds: resolveBuIds(payload, buId)
          };
        } catch (error) {
          request.log.warn({ err: error.message }, 'JWT verify failed');
          if (mode === 'jwt') {
            throw unauthorized('Invalid or expired token');
          }
          // hybrid: fall through to the legacy header path.
        }
      }
    }

    if (!context && mode !== 'jwt') {
      context = contextFromHeaders(request);
    }

    request.userContext = context ?? { userId: null, role: null, buId: null, buIds: null };

    // Strict mode: every /api/* route needs a valid identity. Route-level
    // guard(...) still runs on top of this for role checks.
    if (mode === 'jwt' && !isPublicPath(request.url) && !request.userContext.userId) {
      throw unauthorized(tokenPresent ? 'Invalid or expired token' : 'Authentication required');
    }
  });
}
