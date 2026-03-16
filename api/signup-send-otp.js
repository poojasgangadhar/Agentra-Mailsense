// api/signup-send-otp.js
const { sql, initDB }           = require('./_db');
const { generateOTP, sendOTP }  = require('./_mailer');
const { saveOTP, getOTP }       = require('./_otpStore');

module.expsorts = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { first_name, last_name, email, password } = req.body;
  if (!first_name || !last_name || !email || !password)
    return res.status(400).json({ error: 'All fields are required.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    await initDB();
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    // Rate limit
    const existingOTP = await getOTP(`signup_${email}`);
    if (existingOTP) {
      const age = Date.now() - (existingOTP.expiresAt - 10 * 60 * 1000);
      const wait = Math.ceil(60 - age / 1000);
      if (wait > 0) return res.status(429).json({ error: `Please wait ${wait}s before requesting again.` });
    }

    const otp = generateOTP();
    await saveOTP(`signup_${email}`, {
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      extra: { first_name, last_name, password },
    });

    await sendOTP(email, otp, 'signup');
    console.log(`✅ Signup OTP sent → ${email}`);
    res.json({ success: true, message: 'Verification code sent to your email!' });

  } catch (err) {
    console.error('Signup send-otp error:', err);
    res.status(500).json({ error: 'Failed to send verification email. Check your email config.' });
  }
};