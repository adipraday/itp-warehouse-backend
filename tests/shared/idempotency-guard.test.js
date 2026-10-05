import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repository from '../../src/shared/idempotency/idempotency.repository.js';
import { withIdempotency } from '../../src/shared/idempotency/idempotency.guard.js';
import { hashRequestBody } from '../../src/shared/idempotency/request-hash.js';

vi.mock('../../src/shared/idempotency/idempotency.repository.js');

const body = { notes: 'selesai' };
const stored = { data: { id: 7, status: 'COMPLETED' } };
const request = { key: '10:abc', endpoint: 'POST /api/inbounds/7/complete', body, ttlHours: 24 };

function completedRecord(responseBody) {
  return {
    id: 1,
    endpoint: request.endpoint,
    request_hash: hashRequestBody(body),
    status: 'COMPLETED',
    response_code: 200,
    response_body: responseBody
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('withIdempotency replay', () => {
  // MariaDB 10.4 (and our pool, jsonStrings) returns the JSON column as a string;
  // mysql2 on MariaDB 10.5+ without jsonStrings returns it already parsed.
  it.each([
    ['a JSON string', JSON.stringify(stored)],
    ['an already-parsed object', stored]
  ])('replays the stored response when the column comes back as %s', async (_label, responseBody) => {
    repository.getOrCreate.mockResolvedValue(completedRecord(responseBody));
    const work = vi.fn();

    const result = await withIdempotency({}, request, work);

    expect(result).toEqual({ replayed: true, statusCode: 200, body: stored });
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects the same key with a different body', async () => {
    repository.getOrCreate.mockResolvedValue({ ...completedRecord('{}'), request_hash: 'other' });
    await expect(withIdempotency({}, request, vi.fn())).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('runs the work and stores its response on the first request', async () => {
    repository.getOrCreate.mockResolvedValue({ ...completedRecord(null), status: 'PROCESSING' });
    const work = vi.fn().mockResolvedValue({ statusCode: 200, body: stored });

    const result = await withIdempotency({}, request, work);

    expect(result).toEqual({ replayed: false, statusCode: 200, body: stored });
    expect(repository.markCompleted).toHaveBeenCalledWith({}, 1, { responseCode: 200, responseBody: stored });
  });
});
