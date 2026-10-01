import { getMessaging } from './firebase-admin.js';
import * as deviceTokensRepository from '../../modules/device-tokens/device-tokens.repository.js';

const DEAD_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

// Best-effort, always — a push-sending hiccup (FCM down, a malformed
// payload, a DB blip looking up tokens) must never fail the business
// operation that triggered it (e.g. submitting a stock opname), so the
// entire body is one big try/catch with no rethrow.
export async function notifyRole(db, { role, buId, title, body, data = {} }) {
  try {
    const messaging = getMessaging();
    if (!messaging || buId == null) return;

    const tokens = await deviceTokensRepository.findTokensForRoleAndBu(db, role, buId);
    if (tokens.length === 0) return;

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      // FCM data payloads must be string-only values.
      data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
      android: { priority: 'high' }
    });

    const deadTokens = [];
    response.responses.forEach((result, index) => {
      if (!result.success && DEAD_TOKEN_ERROR_CODES.has(result.error?.code)) {
        deadTokens.push(tokens[index]);
      }
    });
    if (deadTokens.length > 0) {
      await deviceTokensRepository.removeTokens(db, deadTokens);
    }
  } catch (error) {
    console.warn('[push] notifyRole failed', { role, buId, error: error.message });
  }
}
