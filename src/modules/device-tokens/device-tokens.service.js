import * as repository from './device-tokens.repository.js';

export async function registerDeviceToken(db, { fcm_token, platform }, userContext) {
  const row = await repository.upsert(db, {
    user_id: userContext.userId,
    fcm_token,
    role: userContext.role,
    bu_id: userContext.buId,
    platform: platform ?? null
  });
  return { data: row };
}

export async function unregisterDeviceToken(db, fcm_token) {
  await repository.remove(db, fcm_token);
  return { data: { fcm_token } };
}
