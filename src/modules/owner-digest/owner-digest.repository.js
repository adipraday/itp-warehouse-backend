// Claim ledger for the owner daily digest — see migrations/202610120001_add_owner_digest_log.js.

// Atomically claims (user, day). Resolves true only for the caller that inserted the row, i.e.
// the one that is now responsible for sending that digest.
export async function claim(db, userId, digestDate) {
  const [result] = await db.execute('INSERT IGNORE INTO owner_digest_log (user_id, digest_date) VALUES (?, ?)', [
    userId,
    digestDate
  ]);
  return result.affectedRows === 1;
}

// Gives the day back so the next scheduler tick retries — used when building/sending failed
// after the claim, so a transient DB/FCM problem doesn't silently skip a digest.
export async function release(db, userId, digestDate) {
  await db.execute('DELETE FROM owner_digest_log WHERE user_id = ? AND digest_date = ?', [userId, digestDate]);
}
