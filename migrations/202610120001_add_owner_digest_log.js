// Owner daily digest (2026-10-12): one row per (owner, business day) once that day's summary has
// been claimed for sending. The primary key IS the idempotency guard — the scheduler claims a day
// with INSERT IGNORE and only the caller that actually inserted the row sends, so a restart, a
// catch-up tick or two app instances can never deliver the same digest twice.
//
// user_id: plain INT, no FK (users live in the auth service, same convention as device_tokens /
// user_directory). digest_date: the business day the digest SUMMARISES (yesterday at send time).
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE owner_digest_log (
      user_id INT NOT NULL,
      digest_date DATE NOT NULL,
      claimed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (user_id, digest_date)
    ) ENGINE=InnoDB
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS owner_digest_log');
}
