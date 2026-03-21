// api/emails/fetch.js
// Fetches emails from Gmail API for the logged-in user

const { sql, initDB } = require('../_db');

// Refresh access token if expired
async function refreshAccessToken(email, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    // Update token in DB
    await sql`
      UPDATE gmail_tokens
      SET access_token = ${data.access_token},
          expires_at   = ${new Date(Date.now() + data.expires_in * 1000)},
          updated_at   = NOW()
      WHERE email = ${email}
    `;
    return data.access_token;
  }
  throw new Error('Failed to refresh token');
}

// Get valid access token
async function getValidToken(email) {
  const result = await sql`SELECT * FROM gmail_tokens WHERE email = ${email}`;
  if (result.rows.length === 0) throw new Error('Gmail not connected');

  const token = result.rows[0];
  const isExpired = new Date(token.expires_at) < new Date(Date.now() + 60000);

  if (isExpired && token.refresh_token) {
    return await refreshAccessToken(email, token.refresh_token);
  }
  return token.access_token;
}

// Classify email using simple rules (AI classification next step)
function classifyEmail(email) {
  const from    = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const body    = (email.snippet || '').toLowerCase();

  // Spam indicators
  if (subject.includes('winner') || subject.includes('lottery') ||
      subject.includes('prize') || subject.includes('urgent') ||
      subject.includes('click here') || subject.includes('free money')) {
    return 'Spam';
  }

  // Promotions indicators
  if (from.includes('noreply') || from.includes('no-reply') ||
      from.includes('newsletter') || from.includes('marketing') ||
      from.includes('promotions') || from.includes('offers') ||
      subject.includes('sale') || subject.includes('offer') ||
      subject.includes('discount') || subject.includes('% off') ||
      subject.includes('unsubscribe') || body.includes('unsubscribe')) {
    return 'Promotions';
  }

  return 'Important';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { email, category = 'all', maxResults = 20 } = req.query;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    await initDB();
    const accessToken = await getValidToken(email);

    // Build Gmail query based on category
    let query = '';
    if (category === 'Spam')       query = 'in:spam';
    else if (category === 'Promotions') query = 'category:promotions';
    else if (category === 'Important')  query = 'is:important';
    else if (category === 'Bin')        query = 'in:trash';
    else query = 'in:inbox';

    // Fetch email list
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const listData = await listRes.json();

    if (!listData.messages || listData.messages.length === 0) {
      return res.json({ emails: [], total: 0 });
    }

    // Fetch each email's details
    const emails = await Promise.all(
      listData.messages.slice(0, maxResults).map(async (msg) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const msgData = await msgRes.json();

        const headers = msgData.payload?.headers || [];
        const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

        const emailObj = {
          id:       msgData.id,
          threadId: msgData.threadId,
          from:     getHeader('From'),
          subject:  getHeader('Subject') || '(No subject)',
          date:     getHeader('Date'),
          snippet:  msgData.snippet || '',
          labels:   msgData.labelIds || [],
          read:     !msgData.labelIds?.includes('UNREAD'),
        };

        emailObj.category = classifyEmail(emailObj);
        return emailObj;
      })
    );

    // Count by category
    const counts = {
      total:      emails.length,
      Important:  emails.filter(e => e.category === 'Important').length,
      Promotions: emails.filter(e => e.category === 'Promotions').length,
      Spam:       emails.filter(e => e.category === 'Spam').length,
    };

    res.json({ emails, counts, total: emails.length });

  } catch (err) {
    console.error('Fetch emails error:', err.message);
    if (err.message === 'Gmail not connected') {
      return res.status(401).json({ error: 'Gmail not connected', needsConnect: true });
    }
    res.status(500).json({ error: 'Failed to fetch emails.' });
  }
};