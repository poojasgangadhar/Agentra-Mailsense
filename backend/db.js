// backend/db.js — uses Turso (hosted SQLite, works on Vercel)
require('dotenv').config();
const { createClient } = require('@libsql/client');

if (!process.env.TURSO_URL || !process.env.TURSO_TOKEN) {
  console.error('[db] FATAL: TURSO_URL or TURSO_TOKEN env var is missing. Set them in Vercel Project Settings → Environment Variables (Production).');
}

// createClient() validates the URL SYNCHRONOUSLY and throws immediately
// if it's missing/malformed — that's a require()-time crash, which takes
// down the whole serverless function for every route before any request
// handling or error middleware ever runs. Guard it so a misconfigured
// env var becomes a normal rejected promise instead, which the existing
// initPromise.catch(next) / global error handler can turn into a clean
// JSON 500.
let db;
if (process.env.TURSO_URL && process.env.TURSO_TOKEN) {
  db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });
} else {
  const configError = () => Promise.reject(new Error('Database not configured: TURSO_URL/TURSO_TOKEN env vars are missing.'));
  db = { execute: configError, executeMultiple: configError };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
    agent_mode TEXT NOT NULL DEFAULT 'safe', is_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code TEXT NOT NULL,
    type TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS gmail_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL, refresh_token TEXT, token_expiry TEXT, scope TEXT,
    connected_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY, user_email TEXT NOT NULL, gmail_id TEXT NOT NULL, thread_id TEXT,
    from_addr TEXT, from_name TEXT, subject TEXT, snippet TEXT, body TEXT,
    tag TEXT DEFAULT 'important', color TEXT DEFAULT '#4f6ef7',
    replied INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
    email_time TEXT, fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL,
    dot_color TEXT NOT NULL DEFAULT 'blue', message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_stats (
    user_email TEXT PRIMARY KEY, total INTEGER DEFAULT 0, important INTEGER DEFAULT 0,
    promo INTEGER DEFAULT 0, spam INTEGER DEFAULT 0, replied INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_email TEXT NOT NULL, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_email, setting_key)
  );
`;

function toArgs(sql, args) {
  if (args.length === 0) return [];
  // Single named-param object (has $ params in SQL)
  if (args.length === 1
      && args[0] !== null
      && typeof args[0] === 'object'
      && !Array.isArray(args[0])
      && /[$@:][a-zA-Z_]/.test(sql)) {
    return args[0];
  }
  // Positional — flatten to array
  return args.flat();
}

function rowToObj(row, columns) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

function prepare(sql) {
  return {
    async run(...args) {
      await db.execute({ sql, args: toArgs(sql, args) });
    },
    async get(...args) {
      const res = await db.execute({ sql, args: toArgs(sql, args) });
      return res.rows[0] ? rowToObj(res.rows[0], res.columns) : undefined;
    },
    async all(...args) {
      const res = await db.execute({ sql, args: toArgs(sql, args) });
      return res.rows.map(r => rowToObj(r, res.columns));
    },
  };
}

async function query(sql, ...args) {
  const res = await db.execute({ sql, args: toArgs(sql, args) });
  return res.rows.map(r => rowToObj(r, res.columns));
}

async function queryOne(sql, ...args) {
  const res = await db.execute({ sql, args: toArgs(sql, args) });
  return res.rows[0] ? rowToObj(res.rows[0], res.columns) : undefined;
}

async function exec(sql, ...args) {
  await db.execute({ sql, args: toArgs(sql, args) });
}

async function recomputeStats(userEmail) {
  const rows = await query("SELECT tag, COUNT(*) as cnt FROM emails WHERE user_email = ? AND deleted = 0 GROUP BY tag", userEmail);
  const repliedRow = await queryOne("SELECT COUNT(*) as cnt FROM emails WHERE user_email = ? AND replied = 1 AND deleted = 0", userEmail);
  const stats = { user_email: userEmail, total: 0, important: 0, promo: 0, spam: 0, replied: Number(repliedRow?.cnt || 0) };
  for (const r of rows) {
    stats.total += Number(r.cnt);
    if (r.tag === 'important') stats.important = Number(r.cnt);
    if (r.tag === 'promo')     stats.promo     = Number(r.cnt);
    if (r.tag === 'spam')      stats.spam      = Number(r.cnt);
  }
  await stmts.upsertStats.run(stats);
  return stats;
}

async function markEmailsDeleted(userEmail, emailIds) {
  if (!emailIds.length) return;

  const ph = emailIds.map(() => '?').join(',');

  const result = await db.execute({
    sql: `UPDATE emails SET deleted = 1 WHERE user_email = ? AND id IN (${ph})`,
    args: [userEmail, ...emailIds]
  });

}

const stmts = {
  getUserByEmail:   prepare('SELECT * FROM users WHERE email = ?'),
  createUser:       prepare('INSERT INTO users (first_name, last_name, email, password, role, is_verified) VALUES ($first_name, $last_name, $email, $password, $role, $is_verified)'),
  verifyUser:       prepare('UPDATE users SET is_verified = 1 WHERE email = ?'),
  updatePassword:   prepare('UPDATE users SET password = ? WHERE email = ?'),
  deleteUser:       prepare('DELETE FROM users WHERE email = ?'),
  insertOTP:        prepare('INSERT INTO otp_codes (email, code, type, expires_at) VALUES ($email, $code, $type, $expires_at)'),
  getValidOTP:      prepare("SELECT * FROM otp_codes WHERE email = ? AND type = ? AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1"),
  markOTPUsed:      prepare('UPDATE otp_codes SET used = 1 WHERE id = ?'),
  getToken:         prepare('SELECT * FROM gmail_tokens WHERE user_email = ?'),
  upsertToken:      prepare('INSERT INTO gmail_tokens (user_email, access_token, refresh_token, token_expiry, scope) VALUES ($user_email, $access_token, $refresh_token, $token_expiry, $scope) ON CONFLICT(user_email) DO UPDATE SET access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, gmail_tokens.refresh_token), token_expiry = excluded.token_expiry, scope = excluded.scope'),
  deleteToken:      prepare('DELETE FROM gmail_tokens WHERE user_email = ?'),
  upsertEmail:      prepare('INSERT INTO emails (id, user_email, gmail_id, thread_id, from_addr, from_name, subject, snippet, body, tag, color, email_time) VALUES ($id, $user_email, $gmail_id, $thread_id, $from_addr, $from_name, $subject, $snippet, $body, $tag, $color, $email_time) ON CONFLICT(id) DO UPDATE SET tag = COALESCE(emails.tag, excluded.tag), snippet = excluded.snippet, body = excluded.body'),
  getEmails:        prepare('SELECT * FROM emails WHERE user_email = ? AND deleted = 0 ORDER BY fetched_at DESC LIMIT 100'),
  markEmailReplied: prepare('UPDATE emails SET replied = 1 WHERE id = ?'),
  insertLog:        prepare('INSERT INTO agent_logs (user_email, dot_color, message) VALUES (?, ?, ?)'),
  getLogs:          prepare('SELECT * FROM agent_logs WHERE user_email = ? ORDER BY id DESC LIMIT 100'),
  upsertStats:      prepare("INSERT INTO agent_stats (user_email, total, important, promo, spam, replied) VALUES ($user_email, $total, $important, $promo, $spam, $replied) ON CONFLICT(user_email) DO UPDATE SET total = excluded.total, important = excluded.important, promo = excluded.promo, spam = excluded.spam, replied = excluded.replied, updated_at = datetime('now')"),
};

const initPromise = db.executeMultiple(SCHEMA)
  .then(() => console.log('[db] Turso initialised OK'))
  .catch(err => {
    console.error('[db] FATAL:', err.message);
    // Do NOT process.exit() here — this runs inside a serverless function.
    // Exiting kills the whole Lambda invocation (FUNCTION_INVOCATION_FAILED)
    // for every route, including ones that don't touch the DB.
    // Rethrow so server.js's initPromise.catch(next) can return a clean JSON 500.
    throw err;
  });

module.exports = { db, stmts, initPromise, recomputeStats, markEmailsDeleted, query, queryOne, exec };