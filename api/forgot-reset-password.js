// api/forgot-reset-password.js
const bcrypt = require('bcryptjs');
const { sql, initDB }           = require('./_db');
const { getOTP, deleteOTP }     = require('./_otpStore');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { email, password } = req.body;
  if (!email || !password)  return res.status(400).json({ error: 'Email and new password are required.' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const record = await getOTP(`forgot_${email}`);
    if (!record || !record.extra.verified)
      return res.status(403).json({ error: 'Please verify your identity first.' });
    if (Date.now() > record.expiresAt) {
      await deleteOTP(`forgot_${email}`);
      return res.status(403).json({ error: 'Session expired. Please start over.' });
    }

    await initDB();
    const hashed = await bcrypt.hash(password, 10);
    await sql`UPDATE users SET password = ${hashed} WHERE email = ${email}`;
    await deleteOTP(`forgot_${email}`);

    console.log(`✅ Password reset: ${email}`);
    res.json({ success: true, message: 'Password updated! You can now sign in.' });

  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to update password. Try again.' });
  }
};