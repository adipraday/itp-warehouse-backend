// Route-level authorization. Mount as an onRequest hook on routes that only
// certain roles may call (onRequest so the role check precedes schema validation):
//
//   app.post('/', { onRequest: authorize('super-admin', 'admin-bu'), schema }, handler)
//
// Identity comes from request.userContext (populated by user-context.js, also an
// onRequest hook registered earlier). The role/endpoint matrix lives in
// role-matrix.js — prefer wiring routes through `guard()` there instead of
// scattering role lists across modules.

function authError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function authorize(...allowedRoles) {
  return async function authorizePreHandler(request) {
    const ctx = request.userContext;

    if (!ctx || !ctx.userId) {
      throw authError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(ctx.role)) {
      throw authError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }
  };
}

// Any authenticated user (valid identity, role irrelevant).
export const requireAuth = authorize();
