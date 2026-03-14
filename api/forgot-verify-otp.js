// api/forgot-verify-otp.js
const { getOTP, incrementAttempts, deleteOTP, markVerified } = require('./_otpStore');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required.' });

  try {
    const record = await getOTP(`forgot_${email}`);

    if (!record)
      return res.status(400).json({ error: 'No code found. Please request a new one.' });
    if (Date.now() > record.expiresAt) {
      await deleteOTP(`forgot_${email}`);
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }
    if (record.attempts >= 5) {
      await deleteOTP(`forgot_${email}`);
      return res.status(400).json({ error: 'Too many attempts. Please request a new code.' });
    }
    if (record.otp !== otp.toString().trim()) {
      await incrementAttempts(`forgot_${email}`);
      const left = 5 - (record.attempts + 1);
      return res.status(400).json({ error: `Invalid verification code. ${left} attempt${left !== 1 ? 's' : ''} remaining.` });
    }

    await markVerified(`forgot_${email}`);
    console.log(`✅ Forgot-pw OTP verified: ${email}`);
    res.json({ success: true, message: 'Identity verified! You can now set a new password.' });

  } catch (err) {
    console.error('Forgot verify error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
};