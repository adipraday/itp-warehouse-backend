import { directBuIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';
import { BUSINESS_UTC_OFFSET, DB_UTC_OFFSET } from '../../shared/utils/business-time.js';

// Reads of the activity log used to flag unusual behaviour. Read-only. The log (see
// shared/activity-log/log-hook.js) records WHO did WHAT to WHICH document and WHEN — it does not
// store before/after values — so every signal here is derived from those four facts.
//
// Entity types that are business transactions (as opposed to master data):
export const TRANSACTION_ENTITIES = [
  'INBOUND',
  'OUTBOUND',
  'STOCK_TRANSFER',
  'STOCK_OPNAME',
  'SALE',
  'PURCHASE',
  'PAYMENT',
  'RETURN'
];

const WIB_HOUR = `HOUR(CONVERT_TZ(created_at, '${DB_UTC_OFFSET}', '${BUSINESS_UTC_OFFSET}'))`;

function baseFilter({ from, toExclusive, buIds, assignedWarehouseIds }) {
  // `from` / `toExclusive` are WIB calendar dates; created_at is stored in UTC.
  const conditions = [
    `created_at >= CONVERT_TZ(?, '${BUSINESS_UTC_OFFSET}', '${DB_UTC_OFFSET}')`,
    `created_at < CONVERT_TZ(?, '${BUSINESS_UTC_OFFSET}', '${DB_UTC_OFFSET}')`,
    'user_id IS NOT NULL'
  ];
  const params = [`${from} 00:00:00`, `${toExclusive} 00:00:00`];
  // Same scoping as the Activity Logs page itself: rows carry bu_id directly.
  const bu = directBuIdsCondition('bu_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }
  return { conditions, params };
}

// Every log row that can contribute to a finding: cancellations and deletions, edits of items, and
// any transaction action performed during the night window. Newest first.
export async function findCandidateRows(db, { nightStartHour, nightEndHour, limit, ...filter }) {
  const { conditions, params } = baseFilter(filter);
  const entities = TRANSACTION_ENTITIES.map(() => '?').join(',');
  // A window that wraps midnight (22 -> 5) is "hour >= start OR hour < end"; one that doesn't is a range.
  const night =
    nightStartHour > nightEndHour
      ? `(${WIB_HOUR} >= ? OR ${WIB_HOUR} < ?)`
      : `(${WIB_HOUR} >= ? AND ${WIB_HOUR} < ?)`;
  const [rows] = await db.execute(
    `SELECT id, user_id, warehouse_id, action, entity_type, entity_id, created_at, ${WIB_HOUR} AS wib_hour
     FROM activity_logs
     WHERE ${conditions.join(' AND ')}
       AND (
         action IN ('CANCEL', 'DELETE')
         OR (action = 'UPDATE' AND entity_type = 'ITEM')
         OR (entity_type IN (${entities}) AND ${night})
       )
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, ...TRANSACTION_ENTITIES, nightStartHour, nightEndHour, limit]
  );
  return rows;
}

// Per user: how many transaction documents they created in the period — the denominator that
// makes "5 cancellations" mean something different for 6 documents than for 600.
export async function countCreatesByUser(db, filter) {
  const { conditions, params } = baseFilter(filter);
  const entities = TRANSACTION_ENTITIES.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT user_id, COUNT(*) AS total
     FROM activity_logs
     WHERE ${conditions.join(' AND ')} AND action = 'CREATE' AND entity_type IN (${entities})
     GROUP BY user_id`,
    [...params, ...TRANSACTION_ENTITIES]
  );
  return new Map(rows.map((row) => [Number(row.user_id), Number(row.total)]));
}
