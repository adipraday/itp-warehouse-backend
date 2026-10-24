import { directBuIdsCondition } from '../../shared/auth/bu-filter.js';

const SELECT = `
  SELECT r.id, r.request_number, r.bu_id, r.warehouse_id, w.name AS warehouse_name,
         r.requested_by, r.requester_name, r.subject, r.description, r.status, r.source, r.external_ref,
         r.response_note, r.handled_by, r.handled_at, r.created_at, r.updated_at
  FROM item_requests r
  LEFT JOIN warehouses w ON w.id = r.warehouse_id`;

function buildFilter({ buIds, status, warehouseId, requestedBy, source, externalRef, q }) {
  const conditions = [];
  const params = [];

  const bu = directBuIdsCondition('r.bu_id', buIds);
  if (bu) {
    conditions.push(bu.clause);
    params.push(...bu.params);
  }
  if (status) {
    conditions.push(`r.status IN (${status.map(() => '?').join(',')})`);
    params.push(...status);
  }
  if (warehouseId) {
    conditions.push('r.warehouse_id = ?');
    params.push(warehouseId);
  }
  if (requestedBy) {
    conditions.push('r.requested_by = ?');
    params.push(requestedBy);
  }
  if (source) {
    conditions.push('r.source = ?');
    params.push(source);
  }
  if (externalRef) {
    conditions.push('r.external_ref = ?');
    params.push(externalRef);
  }
  if (q) {
    const like = `%${q}%`;
    conditions.push('(r.request_number LIKE ? OR r.subject LIKE ? OR r.description LIKE ? OR r.requester_name LIKE ?)');
    params.push(like, like, like, like);
  }

  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function findAll(db, filter, { limit, offset }) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db.execute(`${SELECT} ${clause} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset
  ]);
  return rows;
}

export async function count(db, filter) {
  const { clause, params } = buildFilter(filter);
  const [rows] = await db.execute(`SELECT COUNT(*) AS total FROM item_requests r ${clause}`, params);
  return Number(rows[0].total);
}

export async function findById(db, id) {
  const [rows] = await db.execute(`${SELECT} WHERE r.id = ?`, [id]);
  return rows[0] ?? null;
}

export async function findByExternalRef(db, buId, externalRef) {
  const [rows] = await db.execute(`${SELECT} WHERE r.bu_id = ? AND r.external_ref = ?`, [buId, externalRef]);
  return rows[0] ?? null;
}

// The request number is derived from the auto-increment id, so it is written right after the insert.
// A throwaway unique placeholder keeps the NOT NULL UNIQUE column valid for that instant.
export async function create(db, data) {
  const [result] = await db.execute(
    `INSERT INTO item_requests
       (request_number, bu_id, warehouse_id, requested_by, requester_name, subject, description, source, external_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `TMP-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      data.bu_id,
      data.warehouse_id ?? null,
      data.requested_by ?? null,
      data.requester_name ?? null,
      data.subject,
      data.description,
      data.source,
      data.external_ref ?? null
    ]
  );
  const id = result.insertId;
  await db.execute('UPDATE item_requests SET request_number = ? WHERE id = ?', [`REQ-${String(id).padStart(6, '0')}`, id]);
  return findById(db, id);
}

// `fromStatuses` makes the change conditional, so two people acting on the same request at once
// cannot both win: the loser's UPDATE matches nothing and the caller reports a conflict.
export async function updateStatus(db, id, { status, responseNote, handledBy, fromStatuses }) {
  const [result] = await db.execute(
    `UPDATE item_requests
     SET status = ?, response_note = COALESCE(?, response_note), handled_by = ?, handled_at = CURRENT_TIMESTAMP(3),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status IN (${fromStatuses.map(() => '?').join(',')})`,
    [status, responseNote ?? null, handledBy ?? null, id, ...fromStatuses]
  );
  return result.affectedRows > 0;
}
