import { ConflictError } from '../errors/app-error.js';
import * as idempotencyRepository from './idempotency.repository.js';
import { hashRequestBody } from './request-hash.js';

// Shared by every complete/approve endpoint: locks (or creates) the idempotency
// record for this key inside the caller's transaction, replays a prior committed
// response verbatim, and rejects key reuse against a different endpoint/body.
export async function withIdempotency(connection, { key, endpoint, body, ttlHours }, work) {
  const requestHash = hashRequestBody(body);
  const record = await idempotencyRepository.getOrCreate(connection, { key, endpoint, requestHash, ttlHours });

  if (record.endpoint !== endpoint || record.request_hash !== requestHash) {
    throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
  }

  if (record.status === 'COMPLETED') {
    return { replayed: true, statusCode: record.response_code, body: JSON.parse(record.response_body) };
  }

  const result = await work();
  await idempotencyRepository.markCompleted(connection, record.id, {
    responseCode: result.statusCode,
    responseBody: result.body
  });

  return { replayed: false, ...result };
}
