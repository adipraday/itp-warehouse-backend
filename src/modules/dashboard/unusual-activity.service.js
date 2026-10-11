import { BadRequestError } from '../../shared/errors/app-error.js';
import { addDays, businessDate } from '../../shared/utils/business-time.js';
import * as repository from './unusual-activity.repository.js';

const DEFAULT_PERIOD_DAYS = 7;
const MAX_PERIOD_DAYS = 90;
const ROW_LIMIT = 20000;
const EXAMPLES_PER_FINDING = 5;

// Conservative on purpose: a flag means "worth a look", not "something went wrong". They are
// returned with every response so the UI can state exactly what was counted.
export const THRESHOLDS = {
  cancellations: 3, // cancelled documents by one person in the period
  deletions: 3, // deleted records by one person
  night_activity: 2, // transaction actions during the night window
  item_edits: 5, // edits of item master data (the log does not say which field changed)
  night_start_hour: 22,
  night_end_hour: 5
};

export const FINDING_TYPES = ['cancellations', 'deletions', 'night_activity', 'item_edits'];

function span(from, to) {
  const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days < 1) throw new BadRequestError('INVALID_DATE_RANGE', '"from" must not be after "to"');
  if (days > MAX_PERIOD_DAYS) {
    throw new BadRequestError('INVALID_DATE_RANGE', `Date range is limited to ${MAX_PERIOD_DAYS} days`);
  }
  return days;
}

function isNight(hour, start, end) {
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

// Groups the activity log by person and flags patterns that deserve a second look: many
// cancellations, many deletions, transactions in the middle of the night, and many edits of item
// master data. Scoped to the caller's business units (the log carries bu_id). Findings are ordered
// most serious first.
export async function getUnusualActivity(db, query, buIds = null, assignedWarehouseIds = null) {
  const to = query.to ?? businessDate();
  const from = query.from ?? addDays(to, -(DEFAULT_PERIOD_DAYS - 1));
  span(from, to);

  const filter = { from, toExclusive: addDays(to, 1), buIds, assignedWarehouseIds };
  const { night_start_hour: nightStart, night_end_hour: nightEnd } = THRESHOLDS;
  const [rows, creates] = await Promise.all([
    repository.findCandidateRows(db, { ...filter, nightStartHour: nightStart, nightEndHour: nightEnd, limit: ROW_LIMIT }),
    repository.countCreatesByUser(db, filter)
  ]);

  const transactional = new Set(repository.TRANSACTION_ENTITIES);
  const groups = new Map(); // `${type}:${user}` -> accumulator

  function add(type, row) {
    const key = `${type}:${row.user_id}`;
    const group = groups.get(key) ?? {
      type,
      user_id: Number(row.user_id),
      count: 0,
      first_at: row.created_at,
      last_at: row.created_at,
      warehouses: new Map(),
      examples: []
    };
    group.count += 1;
    // Rows arrive newest first, so the first one seen is the latest and the last one the earliest.
    group.first_at = row.created_at;
    const warehouseId = row.warehouse_id == null ? null : Number(row.warehouse_id);
    group.warehouses.set(warehouseId, (group.warehouses.get(warehouseId) ?? 0) + 1);
    if (group.examples.length < EXAMPLES_PER_FINDING) {
      group.examples.push({
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id == null ? null : Number(row.entity_id),
        warehouse_id: warehouseId,
        at: row.created_at
      });
    }
    groups.set(key, group);
  }

  for (const row of rows) {
    if (row.action === 'CANCEL' && transactional.has(row.entity_type)) add('cancellations', row);
    if (row.action === 'DELETE') add('deletions', row);
    if (row.action === 'UPDATE' && row.entity_type === 'ITEM') add('item_edits', row);
    if (transactional.has(row.entity_type) && isNight(Number(row.wib_hour), nightStart, nightEnd)) {
      add('night_activity', row);
    }
  }

  const findings = [...groups.values()]
    .filter((group) => group.count >= THRESHOLDS[group.type])
    .map((group) => {
      const [topWarehouse] = [...group.warehouses.entries()].sort((a, b) => b[1] - a[1])[0];
      const created = creates.get(group.user_id) ?? 0;
      return {
        type: group.type,
        user_id: group.user_id,
        count: group.count,
        severity: group.count >= THRESHOLDS[group.type] * 2 ? 'high' : 'medium',
        warehouse_id: topWarehouse,
        first_at: group.first_at,
        last_at: group.last_at,
        // Only meaningful for cancellations: share of the person's own new documents that got cancelled.
        documents_created: group.type === 'cancellations' ? created : null,
        cancel_rate_pct:
          group.type === 'cancellations' && created > 0 ? Number(((group.count / created) * 100).toFixed(1)) : null,
        examples: group.examples
      };
    })
    .sort(
      (a, b) =>
        Number(b.severity === 'high') - Number(a.severity === 'high') ||
        b.count / THRESHOLDS[b.type] - a.count / THRESHOLDS[a.type] ||
        a.user_id - b.user_id
    );

  const byType = Object.fromEntries(FINDING_TYPES.map((type) => [type, 0]));
  for (const finding of findings) byType[finding.type] += 1;

  return {
    data: {
      period: { from, to },
      thresholds: THRESHOLDS,
      summary: {
        findings: findings.length,
        flagged_users: new Set(findings.map((finding) => finding.user_id)).size,
        high_severity: findings.filter((finding) => finding.severity === 'high').length,
        by_type: byType,
        // The log read is capped; if it was hit, counts may be understated.
        row_limit_reached: rows.length >= ROW_LIMIT
      },
      findings
    }
  };
}
