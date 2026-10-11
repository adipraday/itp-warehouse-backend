import { runOwnerDigest } from '../../modules/owner-digest/owner-digest.service.js';

const TICK_MS = 5 * 60 * 1000;

// Starts the in-process owner-digest ticker. It checks every few minutes whether it is time to
// send; the real "only once per owner per day" guarantee lives in the database claim (see
// owner-digest.repository.js), so overlapping ticks, restarts and catch-ups are all harmless.
// Not started from buildApp(), so tests that build the app never spin up a timer.
export function startOwnerDigestScheduler(app) {
  if (!app.config.OWNER_DIGEST_ENABLED) {
    app.log.info('owner digest scheduler disabled (OWNER_DIGEST_ENABLED=false)');
    return null;
  }

  let running = false;
  const tick = async () => {
    if (running) return; // a slow tick must not overlap the next one
    running = true;
    try {
      const sent = await runOwnerDigest(app.db, { sendHour: app.config.OWNER_DIGEST_HOUR, log: app.log });
      if (sent > 0) app.log.info({ sent }, 'owner digest sent');
    } catch (error) {
      app.log.warn({ err: error.message }, 'owner digest tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, TICK_MS);
  timer.unref(); // never keeps the process alive on its own
  app.addHook('onClose', async () => clearInterval(timer));
  app.log.info({ hour: app.config.OWNER_DIGEST_HOUR }, 'owner digest scheduler started');
  // First check shortly after boot, so a restart after the send hour catches up without waiting.
  setTimeout(tick, 30_000).unref();
  return timer;
}
