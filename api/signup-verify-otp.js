// api/signup-verify-otp.js
const bcrypt = require('bcrypt');
const { sql, initDB } = require('./_db');
const { getOTP, incrementAttempts, deleteOTP } = require('./_otpStore');

module.exports = async (req, res) => {
  if (typeof req.body === 'string') req.body = JSON.parse(req.body);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and verification code are required.' });

  try {
    const record = await getOTP(`signup_${email}`);

    if (!record)
      return res.status(400).json({ error: 'No verification code found. Please request a new one.' });
    if (Date.now() > record.expiresAt)
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    if (record.attempts >= 5) {
      await deleteOTP(`signup_${email}`);
      return res.status(400).json({ error: 'Too many wrong attempts. Please request a new code.' });
    }
    if (record.otp !== otp.toString().trim()) {
      await incrementAttempts(`signup_${email}`);
      const left = 5 - (record.attempts + 1);
      return res.status(400).json({ error: `Invalid verification code. ${left} attempt${left !== 1 ? 's' : ''} remaining.` });
    }

    await initDB();
    const { first_name, last_name, password } = record.extra;
    const hashed = await bcrypt.hash(password, 10);
    await sql`INSERT INTO users (first_name, last_name, email, password) VALUES (${first_name}, ${last_name}, ${email}, ${hashed})`;
    await deleteOTP(`signup_${email}`);

    console.log(`✅ Account created: ${email}`);
    res.json({ success: true, message: 'Account created successfully! You can now sign in.' });

  } catch (err) {
    console.error('Signup verify error:', err);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
};