// backend/calendar.js
// ─────────────────────────────────────────────────────────────
//  Google Calendar OAuth2 + API helpers
//  Wraps googleapis to: authorize, check free/busy, create/update/
//  delete events. Mirrors the structure of gmail.js so the two
//  OAuth flows stay consistent and easy to maintain together.
// ─────────────────────────────────────────────────────────────
const { google } = require('googleapis');
require('dotenv').config();

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

// ── Build an OAuth2 client ────────────────────────────────────
// Uses a dedicated redirect URI (GOOGLE_CALENDAR_REDIRECT_URI) so the
// calendar consent flow is independent from the existing Gmail flow —
// a user can connect/disconnect either one without affecting the other.
function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALENDAR_REDIRECT_URI
  );
}

// ── Generate the consent URL ──────────────────────────────────
function getAuthUrl(stateEmail) {
  const oAuth2Client = createOAuth2Client();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       SCOPES,
    state:       stateEmail,
  });
}

// ── Exchange code for tokens ──────────────────────────────────
async function exchangeCode(code) {
  const oAuth2Client = createOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

// ── Build an authorized client from a stored connection row ──
// saveToken(updatedFields) persists refreshed credentials back to the
// DB, same pattern as gmail.js — without it, refreshed access_tokens
// only live in memory and the next request would 401 against a
// stale token.
function buildAuthorizedClient(connRow, saveToken) {
  const oAuth2Client = createOAuth2Client();
  oAuth2Client.setCredentials({
    access_token:  connRow.access_token,
    refresh_token: connRow.refresh_token,
    expiry_date:   connRow.token_expiry ? parseInt(connRow.token_expiry) : undefined,
  });

  oAuth2Client.on('tokens', (newTokens) => {
    connRow.access_token = newTokens.access_token;
    if (newTokens.refresh_token) connRow.refresh_token = newTokens.refresh_token;
    if (newTokens.expiry_date)   connRow.token_expiry  = newTokens.expiry_date.toString();
    if (saveToken) {
      saveToken({
        access_token:  connRow.access_token,
        refresh_token: connRow.refresh_token,
        token_expiry:  connRow.token_expiry,
        scope:         connRow.scope,
      }).catch(err => console.error('[Calendar] Failed to persist refreshed token:', err.message));
    }
  });

  return oAuth2Client;
}

// ── Fetch the connected account's calendar list ───────────────
async function getPrimaryCalendarEmail(connRow, saveToken) {
  const auth = buildAuthorizedClient(connRow, saveToken);
  const oauth2 = google.oauth2({ version: 'v2', auth });
  const { data } = await oauth2.userinfo.get();
  return data.email;
}

// ── Real-time free/busy check across a date range ─────────────
// Used by slot-generation logic to avoid double-booking against
// whatever else is already on the user's Google Calendar.
async function getFreeBusy(connRow, saveToken, timeMinISO, timeMaxISO) {
  const auth = buildAuthorizedClient(connRow, saveToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items:   [{ id: connRow.calendar_id || 'primary' }],
    },
  });
  const cal = data.calendars?.[connRow.calendar_id || 'primary'];
  return cal?.busy || [];
}

// ── Create a calendar event (booking a meeting) ───────────────
// Optionally requests a Google Meet link via conferenceData.
async function createEvent(connRow, saveToken, { title, description, startISO, endISO, timezone, attendees = [], withMeetLink = true }) {
  const auth = buildAuthorizedClient(connRow, saveToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.events.insert({
    calendarId: connRow.calendar_id || 'primary',
    conferenceDataVersion: withMeetLink ? 1 : 0,
    sendUpdates: 'all',
    requestBody: {
      summary: title,
      description,
      start: { dateTime: startISO, timeZone: timezone },
      end:   { dateTime: endISO,   timeZone: timezone },
      attendees: attendees.map(a => ({ email: a.email, displayName: a.name })),
      conferenceData: withMeetLink ? {
        createRequest: { requestId: `agentra-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      } : undefined,
    },
  });
  return {
    eventId:     data.id,
    meetingLink: data.hangoutLink || data.conferenceData?.entryPoints?.[0]?.uri || null,
    htmlLink:    data.htmlLink,
  };
}

// ── Update (reschedule) an existing event ─────────────────────
async function updateEvent(connRow, saveToken, eventId, { startISO, endISO, timezone }) {
  const auth = buildAuthorizedClient(connRow, saveToken);
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.events.patch({
    calendarId: connRow.calendar_id || 'primary',
    eventId,
    sendUpdates: 'all',
    requestBody: {
      start: { dateTime: startISO, timeZone: timezone },
      end:   { dateTime: endISO,   timeZone: timezone },
    },
  });
  return { eventId: data.id };
}

// ── Cancel/delete an event ─────────────────────────────────────
async function deleteEvent(connRow, saveToken, eventId) {
  const auth = buildAuthorizedClient(connRow, saveToken);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({
    calendarId: connRow.calendar_id || 'primary',
    eventId,
    sendUpdates: 'all',
  });
  return { deleted: true };
}

module.exports = {
  SCOPES,
  createOAuth2Client,
  getAuthUrl,
  exchangeCode,
  buildAuthorizedClient,
  getPrimaryCalendarEmail,
  getFreeBusy,
  createEvent,
  updateEvent,
  deleteEvent,
};