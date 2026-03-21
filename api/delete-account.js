// api/delete-account.js
const { sql, initDB } = require('./_db');

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
    await sql`DELETE FROM gmail_tokens WHERE email = ${email}`;
    await sql`DELETE FROM otp_store WHERE key LIKE ${'%' + email + '%'}`;
    await sql`DELETE FROM users WHERE email = ${email}`;
    console.log(`✅ Account deleted: ${email}`);
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
};