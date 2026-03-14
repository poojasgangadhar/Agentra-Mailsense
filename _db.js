// api/_db.js — shared database helper
const { sql } = require('@vercel/postgres');

// Create users table if it doesn't exist
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
}

module.exports = { sql, initDB };