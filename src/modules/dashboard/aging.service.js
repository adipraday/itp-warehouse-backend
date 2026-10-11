import { businessDate } from '../../shared/utils/business-time.js';
import * as repository from './aging.repository.js';

const DEFAULT_LIMIT = 50;
const TOP_CONTACTS = 10;

// Aging buckets by days past due. `current` = not yet due.
export const BUCKETS = [
  { key: 'current', label: 'Belum jatuh tempo', test: (days) => days <= 0 },
  { key: 'd1_30', label: '1–30 hari', test: (days) => days >= 1 && days <= 30 },
  { key: 'd31_60', label: '31–60 hari', test: (days) => days >= 31 && days <= 60 },
  { key: 'd61_90', label: '61–90 hari', test: (days) => days >= 61 && days <= 90 },
  { key: 'd90_plus', label: 'Lebih dari 90 hari', test: (days) => days > 90 }
];

const TYPE_OF_SIDE = { receivable: 'SALES', payable: 'PURCHASE' };

function money(value) {
  return Number(value ?? 0).toFixed(2);
}

// Receivables (what customers owe) or payables (what we owe suppliers): totals, the aging buckets,
// the biggest counterparties, a per-warehouse split, and the oldest unpaid invoices. All figures
// are computed over EVERY outstanding invoice in the caller's scope; only `items` is capped.
export async function getAging(db, query, buIds = null, assignedWarehouseIds = null) {
  const side = query.side;
  const today = businessDate();
  const rows = await repository.findOutstanding(db, {
    type: TYPE_OF_SIDE[side],
    today,
    warehouseId: query.warehouse_id ?? null,
    buIds,
    assignedWarehouseIds
  });

  const buckets = BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label, count: 0, amount: 0 }));
  const contacts = new Map();
  const warehouses = new Map();
  let total = 0;
  let overdueTotal = 0;
  let overdueCount = 0;

  for (const row of rows) {
    const amount = Number(row.outstanding);
    const days = Number(row.days_overdue);
    total += amount;
    if (days > 0) {
      overdueTotal += amount;
      overdueCount += 1;
    }

    const bucketIndex = BUCKETS.findIndex((bucket) => bucket.test(days));
    buckets[bucketIndex].count += 1;
    buckets[bucketIndex].amount += amount;

    const contactKey = row.contact_id ?? 0; // 0 = invoices with no contact (walk-in customer)
    const contact = contacts.get(contactKey) ?? {
      contact_id: row.contact_id == null ? null : Number(row.contact_id),
      contact_name: row.contact_name ?? null,
      count: 0,
      amount: 0,
      oldest_days_overdue: days
    };
    contact.count += 1;
    contact.amount += amount;
    contact.oldest_days_overdue = Math.max(contact.oldest_days_overdue, days);
    contacts.set(contactKey, contact);

    const warehouseKey = Number(row.warehouse_id);
    const warehouse = warehouses.get(warehouseKey) ?? { warehouse_id: warehouseKey, count: 0, amount: 0 };
    warehouse.count += 1;
    warehouse.amount += amount;
    warehouses.set(warehouseKey, warehouse);
  }

  const limit = query.limit ?? DEFAULT_LIMIT;

  return {
    data: {
      side,
      as_of: today,
      total_outstanding: money(total),
      invoice_count: rows.length,
      overdue_total: money(overdueTotal),
      overdue_count: overdueCount,
      buckets: buckets.map((bucket) => ({ ...bucket, amount: money(bucket.amount) })),
      by_contact: [...contacts.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, TOP_CONTACTS)
        .map((contact) => ({ ...contact, amount: money(contact.amount) })),
      by_warehouse: [...warehouses.values()]
        .sort((a, b) => b.amount - a.amount)
        .map((warehouse) => ({ ...warehouse, amount: money(warehouse.amount) })),
      // Oldest overdue first (the repository already orders by days_overdue DESC).
      items: rows.slice(0, limit).map((row) => ({
        invoice_id: Number(row.id),
        invoice_number: row.invoice_number,
        warehouse_id: Number(row.warehouse_id),
        contact_id: row.contact_id == null ? null : Number(row.contact_id),
        contact_name: row.contact_name ?? null,
        invoice_date: row.invoice_date,
        due_date: row.due_date ?? null,
        total_amount: money(row.total_amount),
        paid_amount: money(row.paid_amount),
        outstanding: money(row.outstanding),
        days_overdue: Number(row.days_overdue)
      })),
      truncated: rows.length > limit
    }
  };
}
