// backend/routes/webauthn.js
const express = require('express');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { exec, queryOne, query } = require('../db');
const { requireAuth, signToken } = require('../middleware/auth');

const router = express.Router();

const RP_NAME = 'Agentra MailSense';
const RP_ID   = process.env.RP_ID || 'localhost';
const ORIGIN  = process.env.APP_URL || 'http://localhost:3000';

// ── Ensure passkeys table exists ──────────────────────────────
async function ensureTable() {
  await exec(`CREATE TABLE IF NOT EXISTS passkeys (
    id          TEXT PRIMARY KEY,
    user_email  TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    counter     INTEGER NOT NULL DEFAULT 0,
    device_name TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}
ensureTable().catch(console.error);

// ── In-memory challenge store (short-lived) ───────────────────
const challenges = new Map();
function storeChallenge(email, challenge) {
  challenges.set(email, { challenge, expires: Date.now() + 5 * 60 * 1000 });
}
function getChallenge(email) {
  const entry = challenges.get(email);
  if (!entry || Date.now() > entry.expires) { challenges.delete(email); return null; }
  challenges.delete(email);
  return entry.challenge;
}

// ══ REGISTRATION ══════════════════════════════════════════════

// Step 1 — generate options
router.post('/register/options', requireAuth, async (req, res) => {
  const email = req.user.email;
  try {
    const existing = await query(
      'SELECT id FROM passkeys WHERE user_email = ?', email
    );
    const excludeCredentials = existing.map(r => ({
      id: Buffer.from(r.id, 'base64url'),
      type: 'public-key',
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: email,
      userDisplayName: email,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    storeChallenge(email, options.challenge);
    res.json(options);
  } catch (err) {
    console.error('[webauthn/register/options]', err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2 — verify and save
router.post('/register/verify', requireAuth, async (req, res) => {
  const email = req.user.email;
  const { credential, deviceName } = req.body;
  const expectedChallenge = getChallenge(email);
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired. Please try again.' });

  try {
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified) return res.status(400).json({ error: 'Verification failed.' });

    const { credentialID, credentialPublicKey, counter } =
      verification.registrationInfo;

    const id = Buffer.from(credentialID).toString('base64url');
    const pubKey = Buffer.from(credentialPublicKey).toString('base64');

    await exec(
      `INSERT INTO passkeys (id, user_email, public_key, counter, device_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET counter = excluded.counter`,
      id, email, pubKey, counter, deviceName || 'My Device'
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[webauthn/register/verify]', err);
    res.status(500).json({ error: err.message });
  }
});

// ══ AUTHENTICATION ════════════════════════════════════════════

// Step 1 — generate options (public, no JWT needed)
router.post('/auth/options', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required.' });
  try {
    const passkeys = await query(
      'SELECT id FROM passkeys WHERE user_email = ?', email
    );
    if (!passkeys.length) return res.status(404).json({ error: 'No passkeys registered for this account.' });

    const allowCredentials = passkeys.map(r => ({
      id: Buffer.from(r.id, 'base64url'),
      type: 'public-key',
    }));

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: 'preferred',
    });

    storeChallenge(email, options.challenge);
    res.json(options);
  } catch (err) {
    console.error('[webauthn/auth/options]', err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2 — verify and issue JWT
router.post('/auth/verify', async (req, res) => {
  const { email, credential } = req.body;
  if (!email || !credential) return res.status(400).json({ error: 'email and credential required.' });

  const expectedChallenge = getChallenge(email);
  if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired. Please try again.' });

  try {
    const credId = credential.id;
    const passkey = await queryOne(
      'SELECT * FROM passkeys WHERE id = ? AND user_email = ?', credId, email
    );
    if (!passkey) return res.status(404).json({ error: 'Passkey not found.' });

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: Buffer.from(passkey.id, 'base64url'),
        credentialPublicKey: Buffer.from(passkey.public_key, 'base64'),
        counter: passkey.counter,
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'Authentication failed.' });

    // Update counter
    await exec(
      'UPDATE passkeys SET counter = ? WHERE id = ?',
      verification.authenticationInfo.newCounter, passkey.id
    );

    const token = signToken({ email });
    res.json({ success: true, token, email });
  } catch (err) {
    console.error('[webauthn/auth/verify]', err);
    res.status(500).json({ error: err.message });
  }
});

// ══ MANAGE DEVICES ════════════════════════════════════════════

// List registered passkeys
router.get('/devices', requireAuth, async (req, res) => {
  const email = req.user.email;
  try {
    const devices = await query(
      'SELECT id, device_name, created_at FROM passkeys WHERE user_email = ? ORDER BY created_at DESC',
      email
    );
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a passkey
router.delete('/devices/:id', requireAuth, async (req, res) => {
  const email = req.user.email;
  const { id } = req.params;
  try {
    await exec(
      'DELETE FROM passkeys WHERE id = ? AND user_email = ?', id, email
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
