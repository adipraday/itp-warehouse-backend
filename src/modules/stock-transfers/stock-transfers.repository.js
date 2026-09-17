import { randomUUID } from 'node:crypto';
import { buIdsCondition, assignedWarehouseCondition } from '../../shared/auth/bu-filter.js';

const HEADER_COLUMNS = `id, transfer_number, source_warehouse_id, destination_warehouse_id, status,
       reversal_of_transfer_id, reversal_reason, transfer_date, notes,
       created_by, approved_by, completed_by, approved_at, completed_at, cancelled_at, created_at, updated_at`;

// buIds scopes to transfers touching any of the caller's business units on
// either side (source or destination) — a transfer is relevant to a BU whether
// it's sending or receiving.
function buildFilter({ sourceWarehouseId, destinationWarehouseId, status, buIds, assignedWarehouseIds }) {
  const conditions = [];
  const params = [];
  if (sourceWarehouseId) {
    conditions.push('source_warehouse_id = ?');
    params.push(sourceWarehouseId);
  }
  if (destinationWarehouseId) {
    conditions.push('destination_warehouse_id = ?');
    params.push(destinationWarehouseId);
  }
  const buSource = buIdsCondition('source_warehouse_id', buIds);
  const buDestination = buIdsCondition('destination_warehouse_id', buIds);
  if (buSource && buDestination) {
    conditions.push(`(${buSource.clause} OR ${buDestination.clause})`);
    params.push(...buSource.params, ...buDestination.params);
  }
  // Per-warehouse staff assignment (docs/user-warehouse-assignments.md): layered
  // ON TOP of the BU check above, same "relevant on either side" OR logic.
  const whSource = assignedWarehouseCondition('source_warehouse_id', assignedWarehouseIds);
  const whDestination = assignedWarehouseCondition('destination_warehouse_id', assignedWarehouseIds);
  if (whSource && whDestination) {
    conditions.push(`(${whSource.clause} OR ${whDestination.clause})`);
    params.push(...whSource.params, ...whDestination.params);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function findAll(db, { sourceWarehouseId, destinationWarehouseId, status, buIds, assignedWarehouseIds, limit, offset }) {
  const { clause, params } = buildFilter({ sourceWarehouseId, destinationWarehouseId, status, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(
    `SELECT ${HEADER_COLUMNS} FROM stock_transfers ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows;
}

export async function count(db, { sourceWarehouseId, destinationWarehouseId, status, buIds, assignedWarehouseIds }) {
  const { clause, params } = buildFilter({ sourceWarehouseId, destinationWarehouseId, status, buIds, assignedWarehouseIds });
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM stock_transfers ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`SELECT ${HEADER_COLUMNS} FROM stock_transfers WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByIdForUpdate(connection, id) {
  const [rows] = await connection.execute(`SELECT ${HEADER_COLUMNS} FROM stock_transfers WHERE id = ? FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

export async function findDetails(db, transferId) {
  const [rows] = await db.execute(
    `SELECT d.id, d.item_id, i.sku, i.name, d.quantity
     FROM stock_transfer_details d
     JOIN items i ON i.id = d.item_id
     WHERE d.transfer_id = ?
     ORDER BY d.item_id ASC`,
    [transferId]
  );
  return rows;
}

export async function findByIdWithDetails(db, id) {
  const header = await findById(db, id);
  if (!header) return null;
  header.details = await findDetails(db, id);
  return header;
}

export async function insertHeader(connection, {
  source_warehouse_id,
  destination_warehouse_id,
  transfer_date,
  notes = null,
  reversal_of_transfer_id = null,
  reversal_reason = null
}, createdBy = null) {
  const [result] = await connection.execute(
    `INSERT INTO stock_transfers
       (transfer_number, source_warehouse_id, destination_warehouse_id, status, transfer_date, notes,
        reversal_of_transfer_id, reversal_reason, created_by)
     VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    [
      `TEMP-${randomUUID()}`,
      source_warehouse_id,
      destination_warehouse_id,
      transfer_date,
      notes,
      reversal_of_transfer_id,
      reversal_reason,
      createdBy
    ]
  );
  const id = result.insertId;
  await connection.execute('UPDATE stock_transfers SET transfer_number = ? WHERE id = ?', [
    `TRF-${String(id).padStart(6, '0')}`,
    id
  ]);
  return id;
}

export async function insertDetails(connection, transferId, details) {
  for (const detail of details) {
    await connection.execute('INSERT INTO stock_transfer_details (transfer_id, item_id, quantity) VALUES (?, ?, ?)', [
      transferId,
      detail.item_id,
      detail.quantity
    ]);
  }
}

export async function replaceDetails(connection, transferId, details) {
  await connection.execute('DELETE FROM stock_transfer_details WHERE transfer_id = ?', [transferId]);
  await insertDetails(connection, transferId, details);
}

export async function updateHeader(connection, id, { source_warehouse_id, destination_warehouse_id, transfer_date, notes = null }) {
  await connection.execute(
    `UPDATE stock_transfers
     SET source_warehouse_id = ?, destination_warehouse_id = ?, transfer_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [source_warehouse_id, destination_warehouse_id, transfer_date, notes, id]
  );
}

export async function remove(db, id) {
  await db.execute('DELETE FROM stock_transfers WHERE id = ?', [id]);
}

export async function markApproved(db, id, approvedBy = null) {
  await db.execute(
    `UPDATE stock_transfers SET status = 'APPROVED', approved_by = ?, approved_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'DRAFT'`,
    [approvedBy, id]
  );
}

export async function markCompleted(connection, id, completedBy = null) {
  await connection.execute(
    `UPDATE stock_transfers SET status = 'COMPLETED', completed_by = ?, completed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [completedBy, id]
  );
}

export async function markCancelled(db, id) {
  await db.execute(
    `UPDATE stock_transfers SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status IN ('DRAFT', 'APPROVED')`,
    [id]
  );
}
