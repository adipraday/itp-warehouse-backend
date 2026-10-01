// Push notifications (2026-10-01, requested): lets the backend know which
// FCM token belongs to which user, so it can target a push at "every
// admin-bu for this BU" etc without an extra round-trip to the auth-backend
// on every send. role/bu_id are denormalized from the caller's JWT at
// registration time (refreshed on every app login, not just once ever) —
// acceptable staleness for a notification target, not an authorization
// decision.
//
// user_id: plain INT, no FK (users live in the auth service, same pattern
// as created_by everywhere else). fcm_token is unique — if the same device
// re-registers under a different user (shared device, different login), the
// row's owner just gets reassigned rather than creating a duplicate.
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE device_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      fcm_token VARCHAR(255) NOT NULL,
      role VARCHAR(30) NOT NULL,
      bu_id INT NULL,
      platform VARCHAR(20) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_fcm_token (fcm_token)
    ) ENGINE=InnoDB
  `);
  await knex.raw('CREATE INDEX idx_device_tokens_user ON device_tokens (user_id)');
  await knex.raw('CREATE INDEX idx_device_tokens_role_bu ON device_tokens (role, bu_id)');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS device_tokens');
}
