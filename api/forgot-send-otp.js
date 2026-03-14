// api/forgot-send-otp.js
const { sql, initDB }          = require('./_db');
const { generateOTP, sendOTP } = require('./_mailer');
const { saveOTP, getOTP }      = require('./_otpStore');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    await initDB();
    const user = await sql`SELECT id FROM users WHERE email = ${email}`;
    // Always say sent — don't reveal if email exists
    if (user.rows.length === 0)
      return res.json({ success: true, message: 'If this email exists, a code has been sent.' });

    // Rate limit
    const existingOTP = await getOTP(`forgot_${email}`);
    if (existingOTP) {
      const age  = Date.now() - (existingOTP.expiresAt - 10 * 60 * 1000);
      const wait = Math.ceil(60 - age / 1000);
      if (wait > 0) return res.status(429).json({ error: `Please wait ${wait}s before requesting again.` });
    }

    const otp = generateOTP();
    await saveOTP(`forgot_${email}`, {
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      extra: { verified: false },
    });

    await sendOTP(email, otp, 'reset');
    console.log(`✅ Reset OTP → ${email}`);
    res.json({ success: true, message: 'If this email exists, a code has been sent.' });

  } catch (err) {
    console.error('Forgot send-otp error:', err);
    res.status(500).json({ error: 'Failed to send email. Check your email config.' });
  }
};