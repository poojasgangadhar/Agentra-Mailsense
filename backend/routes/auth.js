// backend/routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { google } = require('googleapis');
const { db, stmts, exec, queryOne } = require('../db');
const { generateOTP, otpExpiresAt, sendOTPEmail } = require('../mailer');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
if (!process.env.JWT_SECRET) {
  // Do NOT throw here — this file is required at serverless module-load
  // time (api/index.js -> server.js -> routes/auth.js), before Express
  // even starts. Throwing crashes the entire function for every route.
  // Falls back to the same default middleware/auth.js uses, so tokens
  // stay valid across both files. Set JWT_SECRET in Vercel for production.
  console.error('[auth] WARNING: JWT_SECRET env var is not set. Using an insecure fallback — set it in Vercel Project Settings for production.');
}
const { signToken, requireAuth } = require('../middleware/auth');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts, please try again later.' }
});

function getGoogleOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_LOGIN_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/api/google-callback`
  );
}

router.get('/google-login', (req, res) => {
  const oAuth2Client = getGoogleOAuth2Client();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
  res.redirect(url);
});

router.get('/google-callback', async (req, res) => {
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  const { code, error } = req.query;
  if (error) return res.redirect(`${APP_URL}/?google_error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect(`${APP_URL}/?google_error=missing_code`);
  try {
    const oAuth2Client = getGoogleOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    const { email, given_name, family_name, name, id: google_id } = profile;
    if (!email) return res.redirect(`${APP_URL}/?google_error=no_email`);
    let user = await stmts.getUserByEmail.get(email);
    if (!user) {
      const first_name = given_name || name?.split(' ')[0] || 'User';
      const last_name  = family_name || name?.split(' ').slice(1).join(' ') || '';
      const hash = await bcrypt.hash(google_id + JWT_SECRET, 12);
      await stmts.createUser.run({ first_name, last_name, email, password: hash, role: 'user', is_verified: 1 });
      user = await stmts.getUserByEmail.get(email);
    } else if (!user.is_verified) {
      await stmts.verifyUser.run(email);
      user = await stmts.getUserByEmail.get(email);
    }
    const token = signToken(user);
    res.redirect(`${APP_URL}/?google_token=${encodeURIComponent(token)}&google_email=${encodeURIComponent(email)}&google_name=${encodeURIComponent(user.first_name)}`);
  } catch (err) {
    console.error('[Google OAuth callback]', err);
    res.redirect(`${APP_URL}/?google_error=auth_failed`);
  }
});

router.post('/signup-send-otp', authLimiter, async (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const existing = await stmts.getUserByEmail.get(email);
    if (existing && existing.is_verified)
      return res.status(409).json({ error: 'An account with this email already exists.' });
    const hash = await bcrypt.hash(password, 12);
    if (existing && !existing.is_verified)
      await exec('DELETE FROM users WHERE email = ? AND is_verified = 0', email);
    await stmts.createUser.run({ first_name, last_name, email, password: hash, role: 'user', is_verified: 0 });
    const otp = generateOTP();
    await stmts.insertOTP.run({ email, code: otp, type: 'signup', expires_at: otpExpiresAt() });
    await sendOTPEmail({ to: email, name: first_name, otp, type: 'signup' });
    res.json({ success: true, message: `Verification code sent to ${email}` });
  } catch (err) {
    console.error('[signup-send-otp]', err);
    if (err.code === 'EAUTH' || err.code === 'ECONNREFUSED' || err.responseCode === 535)
      return res.status(500).json({ error: 'Email delivery failed. Please check your SMTP settings.' });
    res.status(500).json({ error: 'Failed to send verification email.' });
  }
});

router.post('/signup-verify-otp', authLimiter, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required.' });
  const record = await stmts.getValidOTP.get(email, 'signup');
  if (!record) return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
  if (record.code !== otp) return res.status(400).json({ error: 'Incorrect verification code.' });
  await stmts.markOTPUsed.run(record.id);
  await stmts.verifyUser.run(email);
  res.json({ success: true, message: 'Account verified successfully.' });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const user = await stmts.getUserByEmail.get(email);
  if (!user) return res.status(401).json({ error: 'No account found with this email.' });
  if (!user.is_verified) return res.status(401).json({ error: 'Please verify your email before logging in.' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password.' });
  const token = signToken(user);
  res.json({
    success: true, token,
    user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, agent_mode: user.agent_mode },
  });
});

router.post('/forgot-send-otp', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const user = await stmts.getUserByEmail.get(email);
  if (!user || !user.is_verified)
    return res.json({ success: true, message: 'If this email exists, a code was sent.' });
  const otp = generateOTP();
  await stmts.insertOTP.run({ email, code: otp, type: 'forgot', expires_at: otpExpiresAt() });
  try {
    await sendOTPEmail({ to: email, name: user.first_name, otp, type: 'forgot' });
    res.json({ success: true, message: 'Verification code sent.' });
  } catch (err) {
    console.error('[forgot-send-otp]', err);
    res.status(500).json({ error: 'Failed to send email. Check SMTP settings.' });
  }
});

router.post('/forgot-verify-otp', authLimiter, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and code required.' });
  const record = await stmts.getValidOTP.get(email, 'forgot');
  if (!record) return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
  if (record.code !== otp) return res.status(400).json({ error: 'Incorrect verification code.' });
  await stmts.markOTPUsed.run(record.id);
  // Issue a short-lived signed token proving this OTP was verified.
  // The reset endpoint requires this token — it cannot be bypassed.
  const resetToken = jwt.sign(
    { email, purpose: 'password_reset' },
    JWT_SECRET,
    { expiresIn: '10m' }
  );
  res.json({ success: true, message: 'Code verified.', resetToken });
});

router.post('/forgot-reset-password', async (req, res) => {
  const { resetToken, password } = req.body;
  if (!resetToken || !password) return res.status(400).json({ error: 'Reset token and new password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  // Verify the signed reset token issued by forgot-verify-otp.
  let payload;
  try {
    payload = jwt.verify(resetToken, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Reset session expired or invalid. Please start over.' });
  }
  if (payload.purpose !== 'password_reset') {
    return res.status(401).json({ error: 'Invalid reset token.' });
  }

  const email = payload.email;
  const user = await stmts.getUserByEmail.get(email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const hash = await bcrypt.hash(password, 12);
  await stmts.updatePassword.run(hash, email);
  res.json({ success: true, message: 'Password updated successfully.' });
});

router.post('/verify-credentials', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const user = await stmts.getUserByEmail.get(email);
  if (!user) return res.status(401).json({ error: 'No account found with this email.' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password.' });
  res.json({ success: true });
});

router.post('/delete-account', requireAuth, async (req, res) => {
  const { password } = req.body;
  const email = req.user.email;
  if (!password) return res.status(400).json({ error: 'Password required.' });
  const user = await stmts.getUserByEmail.get(email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password. Account not deleted.' });
  await exec('DELETE FROM gmail_tokens WHERE user_email = ?', email);
  await exec('DELETE FROM emails WHERE user_email = ?', email);
  await exec('DELETE FROM agent_logs WHERE user_email = ?', email);
  await exec('DELETE FROM agent_stats WHERE user_email = ?', email);
  await exec('DELETE FROM otp_codes WHERE email = ?', email);
  await stmts.deleteUser.run(email);
  res.json({ success: true, message: 'Account deleted.' });
});

router.post('/save-settings', requireAuth, async (req, res) => {
  const { key, value } = req.body;
  const email = req.user.email;
  if (!key || value === undefined)
    return res.status(400).json({ error: 'key and value required.' });
  try {
    await exec(`INSERT INTO user_settings (user_email, setting_key, setting_value) VALUES (?, ?, ?) ON CONFLICT(user_email, setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`,
      email, key, typeof value === 'string' ? value : JSON.stringify(value));
    res.json({ success: true });
  } catch (err) {
    console.error('[save-settings]', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const email = req.user.email;
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword required.' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  try {
    const user = await stmts.getUserByEmail.get(email);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await exec('UPDATE users SET password = ? WHERE email = ?', hashed, email);
    res.json({ success: true });
  } catch (err) {
    console.error('[change-password]', err);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

module.exports = router;