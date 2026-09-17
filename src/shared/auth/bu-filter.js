// Builds the "scoped to caller's business units" SQL condition for list/read
// queries, given the column holding a row's warehouse_id (or an alias, e.g.
// 's.warehouse_id') and the caller's buIds:
//   - null       → unrestricted (super-admin, or an `owner`/`admin-bu` claim that
//                  somehow carries no restriction — treated the same as before)
//   - number[]   → the business units the caller may see: their home BU plus any
//                  admin-bu grants, or every BU in an `owner`'s company
//                  (see docs/auth-multitenant-coordination.md §7)
//
// Replaces the older single-bu_id `= ?` filters this codebase used before
// multi-tenant grants existed — same shape, now IN (...) over an array.
export function buIdsCondition(warehouseColumn, buIds) {
  if (buIds == null) return null; // unrestricted
  if (buIds.length === 0) return { clause: '1 = 0', params: [] }; // no BU access at all — matches nothing, and IN () is invalid SQL
  const placeholders = buIds.map(() => '?').join(',');
  return {
    clause: `${warehouseColumn} IN (SELECT id FROM warehouses WHERE bu_id IN (${placeholders}))`,
    params: [...buIds]
  };
}

// Same idea, but for a table that carries `bu_id` directly on its own rows
// (warehouses, items, contacts) rather than via a warehouse_id reference —
// a plain `column IN (...)`, no subquery.
export function directBuIdsCondition(column, buIds) {
  if (buIds == null) return null;
  if (buIds.length === 0) return { clause: '1 = 0', params: [] };
  const placeholders = buIds.map(() => '?').join(',');
  return { clause: `${column} IN (${placeholders})`, params: [...buIds] };
}

// Further narrows a warehouse-column filter to a specific set of assigned
// warehouse ids — layered ON TOP OF (never instead of) the BU-level filter
// above. Backs the per-warehouse staff-assignment feature (2026-09-09,
// docs/user-warehouse-assignments.md): a staff-gudang/kasir-sales/purchasing/
// finance user assigned to warehouse "Cabang" only, still bu_id-scoped to
// their whole BU, additionally never sees rows from "Pusat" in the same BU.
//   null      -> not restricted at this layer (admin-bu/owner/super-admin are
//                exempt from assignment entirely, and always pass null here)
//   number[]  -> exactly those warehouse ids. An empty array is normally
//                unreachable in practice — the assignment hook already blocks
//                every /api/* request for a staff user with zero assignments —
//                but handled the same defensive way as buIdsCondition/
//                directBuIdsCondition above (matches nothing, never `IN ()`).
export function assignedWarehouseCondition(warehouseColumn, assignedWarehouseIds) {
  if (assignedWarehouseIds == null) return null;
  if (assignedWarehouseIds.length === 0) return { clause: '1 = 0', params: [] };
  const placeholders = assignedWarehouseIds.map(() => '?').join(',');
  return { clause: `${warehouseColumn} IN (${placeholders})`, params: [...assignedWarehouseIds] };
}
