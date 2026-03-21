// api/auth/callback.js
// Handles OAuth callback, exchanges code for tokens, saves to DB

const { sql, initDB } = require('../_db');

module.exports = async (req, res) => {
  const { code, state: email, error } = req.query;

  if (error) {
    return res.redirect(`/dashboard.html?gmail_error=${error}`);
  }

  if (!code || !email) {
    return res.redirect('/dashboard.html?gmail_error=missing_params');
  }

  const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/auth/callback`
    : 'http://localhost:3000/api/auth/callback';

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.access_token) {
      return res.redirect('/dashboard.html?gmail_error=no_token');
    }

    // Get user's Gmail address from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userRes.json();

    // Save tokens to database
    await initDB();
    await sql`
      INSERT INTO gmail_tokens (email, gmail_address, access_token, refresh_token, expires_at)
      VALUES (
        ${email},
        ${userInfo.email},
        ${tokens.access_token},
        ${tokens.refresh_token || ''},
        ${new Date(Date.now() + tokens.expires_in * 1000)}
      )
      ON CONFLICT (email) DO UPDATE SET
        gmail_address = ${userInfo.email},
        access_token  = ${tokens.access_token},
        refresh_token = ${tokens.refresh_token || ''},
        expires_at    = ${new Date(Date.now() + tokens.expires_in * 1000)},
        updated_at    = NOW();
    `;

    console.log(`✅ Gmail connected for: ${email} → ${userInfo.email}`);
    res.redirect('/dashboard.html?gmail_connected=true');

  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/dashboard.html?gmail_error=server_error');
  }
};