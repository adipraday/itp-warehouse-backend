// In-app notification inbox (2026-10-02, requested): push.js already sends
// FCM for 7 event types but never persisted anything — a push that never
// arrived (app closed, permission denied, FCM down, no token registered yet)
// was gone forever, with no in-app history. This table gives every push a
// durable row per recipient, independent of whether the FCM send itself
// succeeds.
//
// user_id: plain INT, no FK — same convention as device_tokens.user_id
// (users live in the auth service). One row per targeted user (not per
// device/token) — a user with two devices registered still gets one inbox
// entry, matching how a person thinks about "did I see this notification".
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      type VARCHAR(30) NOT NULL,
      data JSON NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB
  `);
  await knex.raw('CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at)');
  await knex.raw('CREATE INDEX idx_notifications_user_unread ON notifications (user_id, is_read)');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS notifications');
}
