// backend/routes/calendar.js
const express = require('express');
const crypto = require('crypto');
const { stmts } = require('../db');
const calendarHelper = require('../calendar');
const { requireAuth, verifyToken } = require('../middleware/auth');

const router = express.Router();

// Persist refreshed OAuth tokens back to DB for a given connection row
function makeSaveToken(connectionId) {
  return async (updated) => {
    await stmts.updateCalendarTokens.run({
      id:            connectionId,
      access_token:  updated.access_token,
      refresh_token: updated.refresh_token || null,
      token_expiry:  updated.token_expiry  || null,
      scope:         updated.scope         || '',
    });
  };
}

// ── Start the Google Calendar OAuth flow ──────────────────────
router.get('/calendar-auth', (req, res) => {
  const token = req.query.token;
  const platform = req.query.platform || '';
  const payload = token && verifyToken(token);
  if (!payload?.email) return res.status(401).send('Authentication required.');
  const state = platform === 'mobile' ? `${token}|mobile` : token;
  res.redirect(calendarHelper.getAuthUrl(state));
});

// ── OAuth callback — exchanges code, stores the connection ────
router.get('/oauth2callback-calendar', async (req, res) => {
  const { code, state: rawState, error } = req.query;
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  const isMobile = rawState && rawState.endsWith('|mobile');
  const token = isMobile ? rawState.slice(0, -7) : rawState;
  const makeRedirect = (path, params) => {
    if (isMobile) return `mailsense://dashboard?${params}`;
    return `${APP_URL}/${path}?${params}`;
  };
  if (error) return res.redirect(makeRedirect('dashboard.html', `calendar=error&reason=${error}`));
  const payload = token && verifyToken(token);
  const email = payload?.email;
  if (!code || !email) return res.redirect(makeRedirect('dashboard.html', 'calendar=error&reason=missing_code'));
  try {
    const tokens = await calendarHelper.exchangeCode(code);
    const connectionId = crypto.randomUUID();

    // Look up the connected Google account's own email (may differ
    // from the MailSense login email) for display in Settings.
    let providerAccountEmail = null;
    try {
      providerAccountEmail = await calendarHelper.getPrimaryCalendarEmail({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokens.expiry_date ? tokens.expiry_date.toString() : null,
      }, null);
    } catch (_) { /* non-fatal — display name is optional */ }

    const existing = await stmts.getCalendarConnection.get(email, 'google');
    if (existing) {
      await stmts.updateCalendarTokens.run({
        id: existing.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expiry: tokens.expiry_date ? tokens.expiry_date.toString() : null,
        scope: tokens.scope || '',
      });
    } else {
      await stmts.insertCalendarConnection.run({
        id: connectionId,
        user_email: email,
        provider: 'google',
        provider_account_email: providerAccountEmail,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expiry: tokens.expiry_date ? tokens.expiry_date.toString() : null,
        scope: tokens.scope || '',
        calendar_id: 'primary',
        is_primary: 1,
      });
    }

    await stmts.insertLog.run(email, 'green', `Google Calendar connected successfully${providerAccountEmail ? ` for <strong>${providerAccountEmail}</strong>` : ''}`);
    res.redirect(makeRedirect('dashboard.html', 'calendar=connected'));
  } catch (err) {
    console.error('[Calendar OAuth]', err);
    res.redirect(makeRedirect('dashboard.html', 'calendar=error&reason=token_exchange'));
  }
});

// ── Connection status (for Settings page) ─────────────────────
router.post('/calendar-status', requireAuth, async (req, res) => {
  const email = req.user.email;
  const conn = await stmts.getCalendarConnection.get(email, 'google');
  if (!conn) return res.json({ connected: false });
  res.json({
    connected: true,
    provider: conn.provider,
    account_email: conn.provider_account_email,
    calendar_id: conn.calendar_id,
    sync_status: conn.sync_status,
    connected_at: conn.connected_at,
  });
});

// ── Disconnect ──────────────────────────────────────────────────
router.post('/calendar-disconnect', requireAuth, async (req, res) => {
  const email = req.user.email;
  const conn = await stmts.getCalendarConnection.get(email, 'google');
  if (!conn) return res.json({ disconnected: true });
  await stmts.deleteCalendarConnection.run(conn.id, email);
  await stmts.insertLog.run(email, 'blue', 'Google Calendar disconnected.');
  res.json({ disconnected: true });
});

// ── Real-time availability check ───────────────────────────────
// Body: { timeMin: ISOString, timeMax: ISOString }
// Returns the busy blocks Google Calendar reports for that range —
// slot-generation logic (Phase 2) subtracts these from working hours.
router.post('/calendar-freebusy', requireAuth, async (req, res) => {
  const email = req.user.email;
  const { timeMin, timeMax } = req.body;
  if (!timeMin || !timeMax) return res.status(400).json({ error: 'timeMin and timeMax are required.' });
  const conn = await stmts.getCalendarConnection.get(email, 'google');
  if (!conn) return res.status(400).json({ error: 'Google Calendar not connected.' });
  try {
    const saveToken = makeSaveToken(conn.id);
    const busy = await calendarHelper.getFreeBusy(conn, saveToken, timeMin, timeMax);
    res.json({ busy });
  } catch (err) {
    console.error('[Calendar freebusy]', err);
    await stmts.markCalendarSyncError.run(conn.id);
    res.status(500).json({ error: 'Failed to check calendar availability.' });
  }
});

module.exports = router;