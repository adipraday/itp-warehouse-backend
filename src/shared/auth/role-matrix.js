// Role x endpoint authorization matrix.
//
// SINGLE SOURCE OF TRUTH for "which role may perform which mutating action".
// Wired into every mutating route via `onRequest: guard(resource, action)`.
// Reads (GET) stay open to every authenticated user, EXCEPT HPP/cost data —
// see HPP_VISIBLE_ROLES below, enforced separately via authorize().
//
// Enforcement respects AUTH_MODE: when an identity is present the role is
// checked in every mode; when there is NO identity, guard() is a no-op in
// hybrid/header mode (jwt mode already rejected the request upstream in
// user-context.js). So flipping AUTH_MODE=jwt is what turns this fully on.
//
// Finalized 2026-08-28 — see docs/auth-integration-guide.md §5 for the
// reviewed/agreed version and the decisions behind it (this file is the
// source of truth for enforcement; the doc records the business rationale).

export const ROLES = [
  'super-admin',  // platform admin (auth backend) — full access here too
  'owner',        // multi-tenant (2026-09-08): view-only across every BU in one company
  'admin-bu',     // top of one business unit (can also hold grants to other BUs — see bu_ids)
  'admin-warehouse', // full operational access, but confined to one warehouse (2026-09-21) — see STAFF_ROLES
  'staff-gudang',
  'kasir-sales',
  'purchasing',
  'finance'
];

// super-admin is allowed everywhere (short-circuited in can()).
// admin-warehouse (2026-09-21) included deliberately: it gets write+submit on
// every ALL_STAFF resource but — since approve/reject below are separate keys
// that only ever list 'admin-bu' — never approve/reject, even on its own
// warehouse's stock-opname/transfer/return. That's the point: a warehouse
// admin can create the paperwork but can't also be the independent check on
// it (segregation of duty), same reasoning as staff-gudang today.
const ALL_STAFF = ['admin-bu', 'admin-warehouse', 'staff-gudang'];

// Narrow, deliberate exception to "reads stay open to every authenticated
// role": HPP/cost data (unit_cost, COGS, gross margin) is hidden from
// staff-gudang and kasir-sales. Wired via authorize(...HPP_VISIBLE_ROLES) as
// an onRequest guard on cost-layers, cost-summary, and dashboard/profit —
// see docs/auth-integration-guide.md §5. Decided 2026-08-28.
// `owner` added 2026-09-08 (K3, docs/auth-multitenant-coordination.md §6) —
// an owner is company-level, cross-BU margin visibility is the point of the role.
// `admin-warehouse` added 2026-09-21 — runs a single warehouse end-to-end,
// margin visibility for their own branch is the point of the role.
export const HPP_VISIBLE_ROLES = ['super-admin', 'owner', 'admin-bu', 'admin-warehouse', 'purchasing', 'finance'];

// `owner` deliberately never appears anywhere below — that's what makes it
// view-only. can() has no short-circuit for it (unlike super-admin), so every
// lookup falls through to a normal allow-list that never includes it, and every
// write/approve/submit action is denied. Do not add 'owner' here (B1,
// docs/auth-multitenant-coordination.md §6) — it belongs only in
// HPP_VISIBLE_ROLES and ROLES above.
const MATRIX = {
  warehouses: { write: ['admin-bu'] },
  // Per-warehouse staff assignment (2026-09-09) — admin-bu manages only their
  // own BU's assignments (enforced by buScope()/assertRowInScope() in the
  // routes, not here); super-admin bypasses via the can() short-circuit above.
  'user-warehouse-assignments': { write: ['admin-bu'] },
  items: { write: ['admin-bu', 'admin-warehouse', 'purchasing'] },
  contacts: { write: ['admin-bu', 'admin-warehouse', 'kasir-sales', 'purchasing'] },

  inbounds: { write: [...ALL_STAFF, 'purchasing'] },
  outbounds: { write: [...ALL_STAFF, 'kasir-sales'] },

  'stock-transfers': { write: ALL_STAFF, approve: ['admin-bu'] },
  'stock-opnames': { write: ALL_STAFF, submit: ALL_STAFF, approve: ['admin-bu'] },
  returns: { write: [...ALL_STAFF, 'kasir-sales'], approve: ['admin-bu'], reject: ['admin-bu'] },

  sales: { write: ['admin-bu', 'admin-warehouse', 'kasir-sales'] },
  // Cash session / shift (2026-09-13) — whoever runs the register opens/closes it.
  'cash-sessions': { write: ['admin-bu', 'admin-warehouse', 'kasir-sales'] },
  purchases: { write: ['admin-bu', 'admin-warehouse', 'purchasing'] },
  // kasir-sales added 2026-09-13 — needed for the cash-session feature to be
  // usable at an actual register: a cashier who can create/complete a sale
  // but couldn't also record its payment made the register workflow require
  // admin-bu/finance intervention on every single transaction.
  payments: { write: ['admin-bu', 'admin-warehouse', 'finance', 'kasir-sales'] },

  // Read-only resources (no mutations exist). Listed for documentation.
  stocks: {},
  'stock-mutations': {},
  'cost-layers': {},
  'cost-summary': {},
  invoices: {},
  dashboard: {},
  'activity-logs': {}
};

// Fallback for a mutation whose resource/action pair is not in MATRIX.
const DEFAULT_WRITE_ROLES = ['admin-bu'];

/**
 * @param {string} role     request.userContext.role
 * @param {string} resource  first path segment after /api, e.g. 'sales'
 * @param {string} action    'write' for POST/PUT/DELETE, or a sub-action:
 *                            'approve' / 'submit' / 'reject'
 */
export function can(role, resource, action) {
  if (role === 'super-admin') {
    return true;
  }

  const resourceRules = MATRIX[resource];

  if (!resourceRules) {
    return false; // unknown resource — deny by default
  }

  const allowed = resourceRules[action] ?? resourceRules.write ?? DEFAULT_WRITE_ROLES;
  return allowed.includes(role);
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  return error;
}

/**
 * onRequest-hook factory. Usage:
 *   app.post('/', { onRequest: guard('sales', 'write'), schema }, handler)
 *   app.post('/:id/approve', { onRequest: guard('stock-transfers', 'approve'), schema }, handler)
 */
export function guard(resource, action = 'write') {
  return async function roleMatrixOnRequest(request) {
    const ctx = request.userContext;

    // No identity: jwt mode already rejected this upstream, so we are in
    // hybrid/header mode — stay lenient during the transition.
    if (!ctx || !ctx.userId) {
      return;
    }

    if (!can(ctx.role, resource, action)) {
      throw forbidden(`Role "${ctx.role ?? 'unknown'}" may not ${action} ${resource}`);
    }
  };
}
