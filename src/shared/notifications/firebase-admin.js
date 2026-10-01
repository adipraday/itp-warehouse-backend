import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging as getFirebaseMessagingInstance } from 'firebase-admin/messaging';

let messaging = null;

// Called once at server boot (see app.js). A missing/unreadable service
// account file (e.g. local dev without one) must not crash the server —
// push sending just becomes a no-op, logged once here instead of failing
// loudly every time something tries to send.
export function initFirebaseMessaging({ serviceAccountPath, logger = console }) {
  try {
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    if (getApps().length === 0) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    messaging = getFirebaseMessagingInstance();
    logger.info('Firebase Admin SDK initialized — push notifications enabled');
  } catch (error) {
    logger.warn({ err: error.message }, 'Firebase Admin SDK not initialized — push notifications disabled');
    messaging = null;
  }
}

export function getMessaging() {
  return messaging;
}
