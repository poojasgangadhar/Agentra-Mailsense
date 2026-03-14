// api/login.js
const bcrypt   = require('bcrypt');
const { sql, initDB } = require('./_db');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    await initDB();
    const result = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (result.rows.length === 0) return res.status(401).json({ error: 'No account found with this email.' });

    const user  = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    console.log(`✅ Login: ${email}`);
    res.json({
      success: true,
      user: { email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
};