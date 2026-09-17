import { createHash } from 'node:crypto';

export function hashRequestBody(body) {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}
