// api/_db.js
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL_UNPOOLED);

async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name  TEXT NOT NULL,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT DEFAULT 'User',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS otp_store (
      key        TEXT PRIMARY KEY,
      otp        TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      attempts   INTEGER DEFAULT 0,
      extra      TEXT DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS gmail_tokens (
      email         TEXT PRIMARY KEY,
      gmail_address TEXT NOT NULL,
      access_token  TEXT NOT NULL,
      refresh_token TEXT DEFAULT '',
      expires_at    TIMESTAMP NOT NULL,
      updated_at    TIMESTAMP DEFAULT NOW()
    );
  `;
}

module.exports = { sql, initDB };