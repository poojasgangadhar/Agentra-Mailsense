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
  try {
    db = createClient({
      url: process.env.TURSO_URL,
      authToken: process.env.TURSO_TOKEN,
    });
  } catch (err) {
    console.error('[db] FATAL: TURSO_URL is set but invalid:', err.message, '— make sure it includes the libsql:// (or https://) prefix.');
    const configError = () => Promise.reject(new Error(`Database not configured: TURSO_URL is malformed (${err.message}).`));
    db = { execute: configError, executeMultiple: configError };
  }
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
    email_time TEXT, internal_date INTEGER DEFAULT 0, fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL,
    dot_color TEXT NOT NULL DEFAULT 'blue', message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_stats (
    user_email TEXT PRIMARY KEY, total INTEGER DEFAULT 0, important INTEGER DEFAULT 0,
    promo INTEGER DEFAULT 0, spam INTEGER DEFAULT 0, social INTEGER DEFAULT 0, updates INTEGER DEFAULT 0, replied INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_email TEXT NOT NULL, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_email, setting_key)
  );

  -- ── AI Appointment Booking (Phase 1) ──────────────────────────
  CREATE TABLE IF NOT EXISTS calendar_connections (
    id TEXT PRIMARY KEY, user_email TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'google',
    provider_account_email TEXT,
    access_token TEXT, refresh_token TEXT, token_expiry TEXT, scope TEXT,
    calendar_id TEXT DEFAULT 'primary',
    is_primary INTEGER NOT NULL DEFAULT 1,
    sync_status TEXT NOT NULL DEFAULT 'active',
    connected_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS availability_rules (
    id TEXT PRIMARY KEY, user_email TEXT NOT NULL,
    day_of_week INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
    buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
    max_meetings_per_day INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS meeting_types (
    id TEXT PRIMARY KEY, user_email TEXT NOT NULL,
    name TEXT NOT NULL, duration_minutes INTEGER NOT NULL,
    location_type TEXT NOT NULL DEFAULT 'google_meet',
    description TEXT, color TEXT DEFAULT '#4f6ef7',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS booking_links (
    id TEXT PRIMARY KEY, user_email TEXT NOT NULL,
    meeting_type_id TEXT, slug TEXT UNIQUE NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 1, requires_approval INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY, user_email TEXT NOT NULL,
    meeting_type_id TEXT, calendar_connection_id TEXT,
    external_event_id TEXT, title TEXT,
    start_time TEXT NOT NULL, end_time TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'ai_email', source_email_id TEXT,
    meeting_link TEXT, is_recurring INTEGER NOT NULL DEFAULT 0, recurrence_rule TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS meeting_attendees (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL,
    email TEXT NOT NULL, name TEXT,
    is_organizer INTEGER NOT NULL DEFAULT 0, rsvp_status TEXT NOT NULL DEFAULT 'pending', tag TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ai_scheduling_sessions (
    id TEXT PRIMARY KEY, user_email TEXT NOT NULL,
    email_thread_id TEXT NOT NULL, meeting_id TEXT,
    status TEXT NOT NULL DEFAULT 'negotiating',
    proposed_slots TEXT, extracted_intent TEXT,
    auto_mode INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  const stats = { user_email: userEmail, total: 0, important: 0, promo: 0, spam: 0, social: 0, updates: 0, replied: Number(repliedRow?.cnt || 0) };
  for (const r of rows) {
    stats.total += Number(r.cnt);
    if (r.tag === 'important') stats.important = Number(r.cnt);
    if (r.tag === 'promo')     stats.promo     = Number(r.cnt);
    if (r.tag === 'spam')      stats.spam      = Number(r.cnt);
    if (r.tag === 'social')    stats.social    = Number(r.cnt);
    if (r.tag === 'updates')   stats.updates   = Number(r.cnt);
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
  upsertEmail:      prepare('INSERT INTO emails (id, user_email, gmail_id, thread_id, from_addr, from_name, subject, snippet, body, tag, color, email_time, internal_date) VALUES ($id, $user_email, $gmail_id, $thread_id, $from_addr, $from_name, $subject, $snippet, $body, $tag, $color, $email_time, $internal_date) ON CONFLICT(id) DO UPDATE SET tag = COALESCE(emails.tag, excluded.tag), snippet = excluded.snippet, body = excluded.body, internal_date = excluded.internal_date'),
  getEmails:        prepare('SELECT * FROM emails WHERE user_email = ? AND deleted = 0 ORDER BY internal_date DESC LIMIT 500'),
  markEmailReplied: prepare('UPDATE emails SET replied = 1 WHERE id = ?'),
  insertLog:        prepare('INSERT INTO agent_logs (user_email, dot_color, message) VALUES (?, ?, ?)'),
  getLogs:          prepare('SELECT * FROM agent_logs WHERE user_email = ? ORDER BY id DESC LIMIT 100'),
  upsertStats:      prepare("INSERT INTO agent_stats (user_email, total, important, promo, spam, social, updates, replied) VALUES ($user_email, $total, $important, $promo, $spam, $social, $updates, $replied) ON CONFLICT(user_email) DO UPDATE SET total = excluded.total, important = excluded.important, promo = excluded.promo, spam = excluded.spam, social = excluded.social, updates = excluded.updates, replied = excluded.replied, updated_at = datetime('now')"),

  // ── Calendar connections (Phase 1 — AI Appointment Booking) ──
  getCalendarConnection:     prepare("SELECT * FROM calendar_connections WHERE user_email = ? AND provider = ? ORDER BY is_primary DESC, connected_at ASC LIMIT 1"),
  getCalendarConnections:    prepare('SELECT * FROM calendar_connections WHERE user_email = ? ORDER BY is_primary DESC, connected_at ASC'),
  getCalendarConnectionById: prepare('SELECT * FROM calendar_connections WHERE id = ?'),
  insertCalendarConnection:  prepare('INSERT INTO calendar_connections (id, user_email, provider, provider_account_email, access_token, refresh_token, token_expiry, scope, calendar_id, is_primary) VALUES ($id, $user_email, $provider, $provider_account_email, $access_token, $refresh_token, $token_expiry, $scope, $calendar_id, $is_primary)'),
  updateCalendarTokens:      prepare("UPDATE calendar_connections SET access_token = $access_token, refresh_token = COALESCE($refresh_token, refresh_token), token_expiry = $token_expiry, scope = $scope, sync_status = 'active', updated_at = datetime('now') WHERE id = $id"),
  markCalendarSyncError:     prepare("UPDATE calendar_connections SET sync_status = 'error', updated_at = datetime('now') WHERE id = ?"),
  deleteCalendarConnection:  prepare('DELETE FROM calendar_connections WHERE id = ? AND user_email = ?'),
};

const MIGRATIONS = [
  // Add internal_date column if missing (migration for existing DBs)
  "ALTER TABLE emails ADD COLUMN internal_date INTEGER DEFAULT 0",
  // Add social and updates columns to agent_stats
  "ALTER TABLE agent_stats ADD COLUMN social INTEGER DEFAULT 0",
  "ALTER TABLE agent_stats ADD COLUMN updates INTEGER DEFAULT 0",
];

const initPromise = db.executeMultiple(SCHEMA)
  .then(async () => {
    for (const migration of MIGRATIONS) {
      try { await db.execute(migration); } catch { /* column already exists */ }
    }
    console.log('[db] Turso initialised OK');
  })
  .catch(err => {
    console.error('[db] FATAL:', err.message);
    // Do NOT process.exit() here — this runs inside a serverless function.
    // Exiting kills the whole Lambda invocation (FUNCTION_INVOCATION_FAILED)
    // for every route, including ones that don't touch the DB.
    // Rethrow so server.js's initPromise.catch(next) can return a clean JSON 500.
    throw err;
  });

module.exports = { db, stmts, initPromise, recomputeStats, markEmailsDeleted, query, queryOne, exec };