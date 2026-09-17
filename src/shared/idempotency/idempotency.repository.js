export async function getOrCreate(connection, { key, endpoint, requestHash, ttlHours }) {
  await connection.execute(
    `INSERT INTO idempotency_requests (idempotency_key, endpoint, request_hash, status, expires_at)
     VALUES (?, ?, ?, 'PROCESSING', DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR))
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [key, endpoint, requestHash, ttlHours]
  );

  const [rows] = await connection.execute(
    `SELECT id, idempotency_key, endpoint, request_hash, status, response_code, response_body
     FROM idempotency_requests
     WHERE id = LAST_INSERT_ID()
     FOR UPDATE`
  );
  return rows[0];
}

export async function markCompleted(connection, id, { responseCode, responseBody }) {
  await connection.execute(
    `UPDATE idempotency_requests
     SET status = 'COMPLETED', response_code = ?, response_body = ?, completed_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [responseCode, JSON.stringify(responseBody), id]
  );
}
