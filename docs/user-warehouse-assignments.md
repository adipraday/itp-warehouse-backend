# Per-warehouse staff assignment

Status: **implemented and live-verified**, 2026-09-09.

## Why this exists

`bu_ids` (see `docs/auth-multitenant-coordination.md` §7) scopes a user to a set
of **business units**. That's the right level for admin-bu/owner/super-admin,
but it's not narrow enough for a BU that runs more than one warehouse — e.g. a
company with "Gudang Pusat" and "Gudang Cabang" under the same `bu_id`, where
each warehouse has its own staff who should only ever see their own
warehouse's data.

The auth-backend token has no warehouse-level claim, and adding one there
would mean re-issuing tokens every time an admin-bu moves a staff member
between warehouses — a cross-service dependency for something that is purely
a warehouse-backend resource-authorization concern. So this feature lives
**entirely in warehouse-backend's own database**, with **no auth-backend or
token-contract changes at all**.

## Design (confirmed 2026-09-09)

1. **Many-to-many.** One staff user may be assigned to more than one
   warehouse (e.g. someone who covers both Pusat and Cabang). Table:
   `user_warehouse_assignments` (migration `202609090002`) — `user_id` (no FK;
   users live in the auth service, same convention as `created_by`
   everywhere else in this codebase), `warehouse_id` (real FK, `ON DELETE
   CASCADE`), `assigned_by`, `created_at`, unique on `(user_id, warehouse_id)`.
2. **Hard block for unassigned staff.** A `staff-gudang` / `kasir-sales` /
   `purchasing` / `finance` user with **zero** assignments is blocked on
   **every** `/api/*` route except `GET /api/me/access-status` — not just
   writes. There's nothing meaningful for them to read either.
3. **Who manages assignments.** `admin-bu` (their own BU's warehouses only)
   and `super-admin` (any BU). Enforced the same way as every other
   BU-boundary check in this codebase: `role-matrix.js` (`can write
   'user-warehouse-assignments'`) + `buScope()` / `assertRowInScope()` for the
   BU-ownership check.

`admin-bu`, `owner`, and `super-admin` are **never** subject to this feature —
they keep their existing BU-wide (or global) scope completely unchanged.
Assigning them to one warehouse would contradict what those roles are for.

## How it works

- **`src/shared/auth/warehouse-assignment.js`** — a global `onRequest` hook
  (registered in `src/app.js`, right after `registerUserContext` and before
  `registerActivityLog`). For every `/api/*` request from a `STAFF_ROLES`
  user, it looks up that user's assignments and sets
  `request.userContext.assignedWarehouseIds` (an array of warehouse ids, or
  `[]`). An empty array on any route other than `/api/me/access-status`
  throws `403 WAREHOUSE_ACCESS_NOT_CONFIGURED`.
- **`GET /api/me/access-status`** (`src/modules/me/`) — the one endpoint an
  unassigned staff user can still reach. Returns
  `{ data: { role, assigned, warehouse_ids } }`. The frontend should call this
  right after login (or on a 403 `WAREHOUSE_ACCESS_NOT_CONFIGURED` from any
  other call) and redirect to a dedicated "Akses Anda belum disiapkan" notice
  page when `assigned === false`.
- **`/api/user-warehouse-assignments`** (`src/modules/user-warehouse-assignments/`)
  — CRUD for admin-bu/super-admin:
  - `GET /` — list (filter by `?user_id=` / `?warehouse_id=`), scoped to the
    caller's BU.
  - `POST /` — `{ user_id, warehouse_id }`, 409 `ASSIGNMENT_EXISTS` if the
    pair already exists.
  - `DELETE /:id` — unassign.
- **Query-level narrowing.** `assignedWarehouseCondition()`
  (`src/shared/auth/bu-filter.js`) is layered **on top of** (never instead
  of) the existing `bu_ids` filtering across every warehouse-referencing
  module: stocks, stock-mutations, cost-layers/cost-summary, inbounds,
  outbounds, stock-transfers, stock-opnames, sales, purchases, invoices,
  payments, returns, dashboard, activity-logs, and the warehouses list itself.
  A staff user assigned only to "Cabang" gets zero rows from "Pusat" in any of
  these, even though both share the same `bu_id`.
- **`buScope()`** (`src/shared/auth/bu-scope.js`) additionally validates a
  *specific* target warehouse named in a write/approve/single-document-read
  request against `assignedWarehouseIds`, independently of the `bu_ids`
  check — so a staff user can't create an inbound at a same-BU warehouse
  they aren't assigned to, even by passing its id directly.

## What's intentionally NOT restricted

- **Items and contacts** — these are BU-wide catalogs, not warehouse-specific.
  A Cabang staff member still needs the full BU item/contact catalog; only
  their *stock and transaction* data is warehouse-scoped.
- **`admin-bu` / `owner` / `super-admin`** — see "Design" above.

## Error codes for the frontend

| Code | Where | Meaning |
|---|---|---|
| `WAREHOUSE_ACCESS_NOT_CONFIGURED` (403) | any `/api/*` except `/api/me/access-status` | Staff user has zero warehouse assignments — redirect to the notice page. |
| `FORBIDDEN` (403) | write/approve endpoints | Target warehouse is outside the caller's BU **or** outside their assigned warehouse(s). |
| `ASSIGNMENT_EXISTS` (409) | `POST /api/user-warehouse-assignments` | That user is already assigned to that warehouse. |

See `docs/frontend-integration-guide.md` for the frontend-facing walkthrough
(login → access-status check → redirect flow, and the new "Assign Staff"
screen for admin-bu).
