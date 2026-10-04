// User directory (2026-10-05, requested): the in-app notification inbox
// (notifications table) used to get rows ONLY for users with a registered FCM
// device token — recipients were resolved from device_tokens. A user who only
// ever uses the web app (no mobile app, so no token) therefore got an empty
// inbox even though the event targeted their role/BU.
//
// This table is the token-independent answer to "who is an admin-bu of BU 3 /
// an admin-warehouse assigned to warehouse 9?". Users live in the auth
// service and warehouse-backend has no users table, so it is filled from the
// verified JWT claims of every authenticated request (throttled — see
// src/shared/auth/user-directory-sync.js), the same denormalize-from-the-JWT
// idea as device_tokens.role/bu_id. A user only appears here once they have
// made at least one authenticated request, so someone who never opens the app
// cannot receive inbox rows until their first visit.
//
// user_id: plain INT primary key, no FK (users live in the auth service, same
// convention as device_tokens.user_id / created_by). bu_ids: JSON array of the
// BUs the token authorises (owner = every BU in the company), NULL = the
// token's unrestricted/null claim. Acceptable staleness: refreshed on every
// (throttled) request, so a role/BU change shows up on the user's next call.
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE user_directory (
      user_id INT NOT NULL PRIMARY KEY,
      role VARCHAR(30) NOT NULL,
      bu_id INT NULL,
      bu_ids JSON NULL,
      last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB
  `);
  await knex.raw('CREATE INDEX idx_user_directory_role_bu ON user_directory (role, bu_id)');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS user_directory');
}
