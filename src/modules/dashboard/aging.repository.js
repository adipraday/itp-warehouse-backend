import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

// Every COMPLETED invoice of one side (SALES = receivables, PURCHASE = payables) that still has an
// unpaid balance, with how many days past its due date it is. Read-only.
//
// outstanding = total_amount - SUM(payments.amount). A payment's `amount` is what was actually
// applied to the invoice (a cash tender's change is excluded — see the 202609130003 migration), so
// this is the real balance. DRAFT and CANCELLED invoices never count: nothing is owed on them.
//
// days_overdue: whole days between `today` (the WIB business date, passed in) and the due date;
// positive = overdue, <= 0 = not due yet. An invoice with no due_date (every one today, since the
// forms don't ask for it) is treated as due on its invoice date, so it ages from the day it was
// issued rather than silently never becoming overdue.
export async function findOutstanding(db, { type, today, warehouseId, buIds, assignedWarehouseIds }) {
  const conditions = ["i.type = ?", "i.status = 'COMPLETED'", 'i.total_amount - COALESCE(p.paid, 0) > 0.004'];
  const params = [today, type];
  if (warehouseId) {
    conditions.push('i.warehouse_id = ?');
    params.push(warehouseId);
  }
  const bu = buIdsCondition('i.warehouse_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  const wh = assignedWarehouseCondition('i.warehouse_id', assignedWarehouseIds);
  if (wh) {
    conditions.push(wh.clause);
    params.push(...wh.params);
  }

  const [rows] = await db.execute(
    `SELECT i.id, i.invoice_number, i.warehouse_id, i.contact_id, c.name AS contact_name,
            i.invoice_date, i.due_date, i.total_amount, COALESCE(p.paid, 0) AS paid_amount,
            i.total_amount - COALESCE(p.paid, 0) AS outstanding,
            DATEDIFF(?, COALESCE(i.due_date, i.invoice_date)) AS days_overdue
     FROM invoices i
     LEFT JOIN contacts c ON c.id = i.contact_id
     LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY days_overdue DESC, i.id ASC`,
    params
  );
  return rows;
}
