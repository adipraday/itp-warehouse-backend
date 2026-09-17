// Business-unit scoping. A user may only act on warehouses whose bu_id is in
// their token's bu_ids (home BU + any admin-bu grants, or every BU in an
// owner's company — docs/auth-multitenant-coordination.md §7). buIds === null
// (super-admin) is global and bypasses this.
//
// Mount as a preValidation hook (NOT onRequest — request.body is only parsed by
// then). guard() stays on onRequest; buScope() runs just after:
//   app.post('/', { onRequest: guard('sales', 'write'), preValidation: buScope('sales'), schema }, handler)
//
// The target warehouse(s) for a request are discovered from:
//   - request.body / request.query: warehouse_id, source_warehouse_id, destination_warehouse_id
//   - request.params.id: the document's own warehouse, looked up per resource
//
// List endpoints called WITHOUT ?warehouse_id are scoped separately, at the
// repository level, via src/shared/auth/bu-filter.js — that's where buIds
// actually does most of its work; this file only validates a request that
// names a SPECIFIC warehouse (by id, or a document's own warehouse).

// How to find the warehouse(s) a :id document belongs to, per route resource.
const DOC_WAREHOUSE_SQL = {
  inbounds: 'SELECT warehouse_id AS w FROM inventory_transactions WHERE id = ?',
  outbounds: 'SELECT warehouse_id AS w FROM inventory_transactions WHERE id = ?',
  sales: 'SELECT warehouse_id AS w FROM invoices WHERE id = ?',
  purchases: 'SELECT warehouse_id AS w FROM invoices WHERE id = ?',
  invoices: 'SELECT warehouse_id AS w FROM invoices WHERE id = ?',
  'stock-opnames': 'SELECT warehouse_id AS w FROM stock_opnames WHERE id = ?',
  returns: 'SELECT warehouse_id AS w FROM item_returns WHERE id = ?',
  'stock-transfers':
    'SELECT source_warehouse_id AS w1, destination_warehouse_id AS w2 FROM stock_transfers WHERE id = ?',
  payments: 'SELECT i.warehouse_id AS w FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?',
  'stock-mutations': 'SELECT warehouse_id AS w FROM stock_mutations WHERE id = ?',
  'cost-layers': 'SELECT warehouse_id AS w FROM inventory_cost_layers WHERE id = ?',
  'cash-sessions': 'SELECT warehouse_id AS w FROM cash_sessions WHERE id = ?'
};

const BODY_KEYS = ['warehouse_id', 'source_warehouse_id', 'destination_warehouse_id'];

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function forbidden(id) {
  const error = new Error(`warehouse ${id} is outside your business unit`);
  error.statusCode = 403;
  error.code = 'FORBIDDEN';
  return error;
}

export function buScope(resource) {
  return async function buScopePreValidation(request) {
    const ctx = request.userContext;

    // No identity (hybrid/header lenient — jwt already rejected upstream):
    // nothing to scope.
    if (!ctx || !ctx.userId) {
      return;
    }

    // Per-warehouse staff assignment (2026-09-09, docs/user-warehouse-assignments.md):
    // a staff-gudang/kasir-sales/purchasing/finance user assigned to specific
    // warehouse(s) is further restricted to exactly those, layered ON TOP of
    // (never instead of) the bu_ids check below — a warehouse can be in the
    // caller's BU and still be off-limits because it isn't one they're
    // assigned to. assignedWarehouseIds is only ever set (by
    // warehouse-assignment.js) for STAFF_ROLES; admin-bu/owner/super-admin
    // never carry it, so this is a no-op for them.
    const assignedWarehouseIds = ctx.assignedWarehouseIds ?? null;

    // super-admin (global, buIds === null) has nothing left to check unless
    // they also somehow carry an assignment restriction (they never do today,
    // but this keeps the two checks independent rather than assuming it).
    if (ctx.buIds == null && assignedWarehouseIds == null) {
      return;
    }

    const db = request.server.db;
    const ids = new Set();

    for (const source of [request.body, request.query]) {
      if (!source || typeof source !== 'object') continue;
      for (const key of BODY_KEYS) {
        const id = positiveInt(source[key]);
        if (id) ids.add(id);
      }
    }

    // A payment references an invoice, not a warehouse directly.
    const invoiceId = positiveInt(request.body?.invoice_id);
    if (invoiceId) {
      const [rows] = await db.execute('SELECT warehouse_id AS w FROM invoices WHERE id = ?', [invoiceId]);
      const id = positiveInt(rows[0]?.w);
      if (id) ids.add(id);
    }

    const docId = positiveInt(request.params?.id);
    if (docId) {
      if (resource === 'warehouses') {
        ids.add(docId); // the :id IS the warehouse
      } else if (DOC_WAREHOUSE_SQL[resource]) {
        const [rows] = await db.execute(DOC_WAREHOUSE_SQL[resource], [docId]);
        for (const value of Object.values(rows[0] ?? {})) {
          const id = positiveInt(value);
          if (id) ids.add(id);
        }
        // No row → document does not exist; let the handler return 404.
      }
    }

    if (ids.size === 0) {
      return;
    }

    const idList = [...ids];
    const [rows] = await db.execute(
      `SELECT id, bu_id FROM warehouses WHERE id IN (${idList.map(() => '?').join(',')})`,
      idList
    );
    const buById = new Map(rows.map((row) => [Number(row.id), row.bu_id]));

    const allowedBu = ctx.buIds == null ? null : ctx.buIds.map(Number);
    const allowedWarehouses = assignedWarehouseIds == null ? null : assignedWarehouseIds.map(Number);
    for (const id of idList) {
      if (!buById.has(id)) continue; // nonexistent warehouse → handler will 404/validate
      if (allowedBu != null && !allowedBu.includes(Number(buById.get(id)))) {
        throw forbidden(id);
      }
      if (allowedWarehouses != null && !allowedWarehouses.includes(id)) {
        throw forbidden(id);
      }
    }
  };
}
