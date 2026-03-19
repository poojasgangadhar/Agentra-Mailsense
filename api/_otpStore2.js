const { sql, initDB } = require('./_db');

async function saveOTP(key, data) {
  await initDB();
  await sql`
    INSERT INTO otp_store (key, otp, expires_at, attempts, extra)
    VALUES (${key}, ${data.otp}, ${new Date(data.expiresAt)}, 0, ${JSON.stringify(data.extra || {})})
    ON CONFLICT (key) DO UPDATE SET
      otp        = ${data.otp},
      expires_at = ${new Date(data.expiresAt)},
      attempts   = 0,
      extra      = ${JSON.stringify(data.extra || {})},
      created_at = NOW();
  `;
}

async function getOTP(key) {
  await initDB();
  const result = await sql`SELECT * FROM otp_store WHERE key = ${key}`;
  if (result.length === 0) return null;
  const row = result[0];
  return {
    otp:       row.otp,
    expiresAt: new Date(row.expires_at).getTime(),
    attempts:  row.attempts,
    extra:     JSON.parse(row.extra || '{}'),
  };
}

async function incrementAttempts(key) {
  await sql`UPDATE otp_store SET attempts = attempts + 1 WHERE key = ${key}`;
}

async function deleteOTP(key) {
  await sql`DELETE FROM otp_store WHERE key = ${key}`;
}

async function markVerified(key) {
  await sql`UPDATE otp_store SET extra = jsonb_set(extra::jsonb, '{verified}', 'true'::jsonb)::text, expires_at = NOW() + INTERVAL '10 minutes' WHERE key = ${key}`;
}

module.exports = { saveOTP, getOTP, incrementAttempts, deleteOTP, markVerified };