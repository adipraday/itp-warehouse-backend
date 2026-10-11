import { businessDate } from '../../shared/utils/business-time.js';
import * as repository from './stuck-queue.repository.js';

const DEFAULT_MIN_AGE_DAYS = 2;
const DEFAULT_LIMIT = 100;

// What the document is waiting for, in terms an owner acts on. Kept next to the repository's kind
// list so a new kind can't be added without deciding which bucket it belongs to.
export const GROUP_OF_KIND = {
  transfer_pending_approval: 'approval',
  opname_pending_approval: 'approval',
  return_pending_approval: 'approval',
  transfer_pending_completion: 'completion',
  return_pending_completion: 'completion',
  opname_pending_submission: 'draft',
  sale_draft: 'draft',
  purchase_draft: 'draft',
  inbound_draft: 'draft',
  outbound_draft: 'draft',
  sale_held: 'held'
};

const GROUPS = ['approval', 'completion', 'draft', 'held'];

// Documents that have been sitting in a "somebody has to act" state for at least `min_age_days`
// business days (default 2; 0 = everything currently pending), oldest first. Scoped to the
// caller's business units like every other dashboard query.
export async function getStuckQueue(db, query, buIds = null, assignedWarehouseIds = null) {
  const minAgeDays = query.min_age_days ?? DEFAULT_MIN_AGE_DAYS;
  const limit = query.limit ?? DEFAULT_LIMIT;
  const today = businessDate();
  const scope = { warehouseId: query.warehouse_id ?? null, buIds, assignedWarehouseIds };

  const [rows, counts] = await Promise.all([
    repository.findQueue(db, { today, minAgeDays, limit, ...scope }),
    repository.countQueueByKind(db, { today, minAgeDays, ...scope })
  ]);

  const byKind = Object.fromEntries(Object.keys(GROUP_OF_KIND).map((kind) => [kind, 0]));
  for (const row of counts) byKind[row.kind] = Number(row.total);

  const byGroup = Object.fromEntries(GROUPS.map((group) => [group, 0]));
  for (const [kind, total] of Object.entries(byKind)) byGroup[GROUP_OF_KIND[kind]] += total;

  return {
    data: {
      min_age_days: minAgeDays,
      as_of: today,
      summary: {
        total: Object.values(byGroup).reduce((sum, value) => sum + value, 0),
        by_group: byGroup,
        by_kind: byKind,
        // The list is capped by `limit`; the client shows "and N more" when this is true.
        truncated: rows.length < Object.values(byGroup).reduce((sum, value) => sum + value, 0)
      },
      items: rows.map((row) => ({
        kind: row.kind,
        group: GROUP_OF_KIND[row.kind],
        document_id: Number(row.document_id),
        document_number: row.document_number,
        warehouse_id: Number(row.warehouse_id),
        to_warehouse_id: row.to_warehouse_id == null ? null : Number(row.to_warehouse_id),
        status: row.status,
        waiting_since: row.waiting_since,
        age_days: Number(row.age_days),
        created_by: row.created_by == null ? null : Number(row.created_by)
      }))
    }
  };
}
