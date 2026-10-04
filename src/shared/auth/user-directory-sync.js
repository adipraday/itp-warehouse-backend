import * as userDirectoryRepository from '../../modules/user-directory/user-directory.repository.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// Keeps user_directory (see migrations/202610050001_add_user_directory.js) in
// step with the verified JWT claims, without a DB write on every request:
// a user is upserted the first time they're seen, whenever their role/BU
// claims change, and otherwise at most once per TTL (just to keep
// last_seen_at roughly fresh). The cache is per-recorder (per app instance),
// not module-global, so tests and multiple apps never share state.
//
// Fire-and-forget by design — returns nothing and never throws. A failed
// directory write must not slow down or fail the request that triggered it
// (worst case the user simply isn't an inbox recipient until a later call
// succeeds), same best-effort stance as push.js.
export function createUserDirectoryRecorder({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const seen = new Map();

  return function record(db, context, log) {
    if (!db || !context?.userId || !context.role) return;

    const signature = JSON.stringify([context.role, context.buId, context.buIds]);
    const previous = seen.get(context.userId);
    const at = now();
    if (previous && previous.signature === signature && at - previous.at < ttlMs) return;

    // Set before the write resolves so concurrent requests from the same
    // user don't all race to upsert; undone on failure so it retries.
    seen.set(context.userId, { signature, at });
    userDirectoryRepository
      .upsert(db, { user_id: context.userId, role: context.role, bu_id: context.buId, bu_ids: context.buIds })
      .catch((error) => {
        seen.delete(context.userId);
        log?.warn?.({ err: error.message }, 'user_directory upsert failed');
      });
  };
}
