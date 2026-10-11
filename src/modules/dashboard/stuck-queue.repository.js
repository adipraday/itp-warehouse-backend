import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';
import { BUSINESS_UTC_OFFSET, DB_UTC_OFFSET } from '../../shared/utils/business-time.js';

// "Antrean macet": documents that are sitting in a state where somebody has to act, listed with
// how long they have been waiting. Read-only; every document type is one SELECT in a UNION so the
// whole queue is sorted and limited in the database. Each SELECT is scoped to the caller's
// business units by the warehouse the document belongs to (a transfer by its SOURCE warehouse).
//
// `waiting_since` is the moment the document entered its current state: created_at for a draft,
// held_at for a held sale, submitted_at / approved_at for documents that advanced a step.
const SOURCES = [
  {
    kind: 'transfer_pending_approval',
    table: 'stock_transfers',
    number: 'transfer_number',
    warehouse: 'source_warehouse_id',
    toWarehouse: 'destination_warehouse_id',
    where: "status = 'DRAFT'",
    since: 'created_at',
    createdBy: 'created_by'
  },
  {
    kind: 'transfer_pending_completion',
    table: 'stock_transfers',
    number: 'transfer_number',
    warehouse: 'source_warehouse_id',
    toWarehouse: 'destination_warehouse_id',
    where: "status = 'APPROVED'",
    since: 'approved_at',
    createdBy: 'created_by'
  },
  {
    kind: 'opname_pending_submission',
    table: 'stock_opnames',
    number: 'opname_number',
    warehouse: 'warehouse_id',
    where: "status = 'DRAFT'",
    since: 'created_at',
    createdBy: 'created_by'
  },
  {
    kind: 'opname_pending_approval',
    table: 'stock_opnames',
    number: 'opname_number',
    warehouse: 'warehouse_id',
    where: "status = 'SUBMITTED'",
    since: 'submitted_at',
    createdBy: 'created_by'
  },
  {
    kind: 'return_pending_approval',
    table: 'item_returns',
    number: 'return_number',
    warehouse: 'warehouse_id',
    where: "status = 'DRAFT'",
    since: 'created_at',
    createdBy: 'created_by'
  },
  {
    kind: 'return_pending_completion',
    table: 'item_returns',
    number: 'return_number',
    warehouse: 'warehouse_id',
    where: "status = 'APPROVED'",
    since: 'approved_at',
    createdBy: 'created_by'
  },
  {
    kind: 'sale_held',
    table: 'invoices',
    number: 'invoice_number',
    warehouse: 'warehouse_id',
    where: "type = 'SALES' AND status = 'DRAFT' AND held_at IS NOT NULL",
    since: 'held_at',
    createdBy: 'created_by'
  },
  {
    kind: 'sale_draft',
    table: 'invoices',
    number: 'invoice_number',
    warehouse: 'warehouse_id',
    where: "type = 'SALES' AND status = 'DRAFT' AND held_at IS NULL",
    since: 'created_at',
    createdBy: 'created_by'
  },
  {
    kind: 'purchase_draft',
    table: 'invoices',
    number: 'invoice_number',
    warehouse: 'warehouse_id',
    where: "type = 'PURCHASE' AND status = 'DRAFT'",
    since: 'created_at',
    createdBy: 'created_by'
  },
  {
    kind: 'inbound_draft',
    table: 'inventory_transactions',
    number: 'transaction_number',
    warehouse: 'warehouse_id',
    where: "type = 'INBOUND' AND status = 'DRAFT'",
    since: 'created_at',
    createdBy: 'created_by'
  },
  {
    kind: 'outbound_draft',
    table: 'inventory_transactions',
    number: 'transaction_number',
    warehouse: 'warehouse_id',
    where: "type = 'OUTBOUND' AND status = 'DRAFT'",
    since: 'created_at',
    createdBy: 'created_by'
  }
];

export const QUEUE_KINDS = SOURCES.map((source) => source.kind);

const WAITING_DAY = `DATE(CONVERT_TZ(waiting_since, '${DB_UTC_OFFSET}', '${BUSINESS_UTC_OFFSET}'))`;

// One UNION ALL over every source, scoped to the caller. Returned as { sql, params } so the same
// inner query backs both the row listing and the per-kind counts.
function buildUnion({ warehouseId, buIds, assignedWarehouseIds }) {
  const params = [];
  const selects = SOURCES.map((source) => {
    const conditions = [source.where, `${source.since} IS NOT NULL`];
    if (warehouseId) {
      conditions.push(`${source.warehouse} = ?`);
      params.push(warehouseId);
    }
    const bu = buIdsCondition(source.warehouse, buIds);
    if (bu) {
      conditions.push(bu.clause);
      params.push(...bu.params);
    }
    const wh = assignedWarehouseCondition(source.warehouse, assignedWarehouseIds);
    if (wh) {
      conditions.push(wh.clause);
      params.push(...wh.params);
    }
    return (
      `SELECT '${source.kind}' AS kind, id AS document_id, ${source.number} AS document_number, ` +
      `${source.warehouse} AS warehouse_id, ${source.toWarehouse ?? 'NULL'} AS to_warehouse_id, ` +
      `status, ${source.since} AS waiting_since, ${source.createdBy} AS created_by ` +
      `FROM ${source.table} WHERE ${conditions.join(' AND ')}`
    );
  });
  return { sql: selects.join(' UNION ALL '), params };
}

// Oldest first. `today` is the business date (WIB) the age is measured against.
export async function findQueue(db, { today, minAgeDays, limit, ...scope }) {
  const union = buildUnion(scope);
  const [rows] = await db.execute(
    `SELECT *, DATEDIFF(?, ${WAITING_DAY}) AS age_days
     FROM (${union.sql}) q
     WHERE DATEDIFF(?, ${WAITING_DAY}) >= ?
     ORDER BY waiting_since ASC, document_id ASC LIMIT ?`,
    [today, ...union.params, today, minAgeDays, limit]
  );
  return rows;
}

export async function countQueueByKind(db, { today, minAgeDays, ...scope }) {
  const union = buildUnion(scope);
  const [rows] = await db.execute(
    `SELECT kind, COUNT(*) AS total
     FROM (${union.sql}) q
     WHERE DATEDIFF(?, ${WAITING_DAY}) >= ?
     GROUP BY kind`,
    [...union.params, today, minAgeDays]
  );
  return rows;
}
