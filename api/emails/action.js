// api/emails/action.js
// Archive, delete, mark read/unread emails

const { sql } = require('../_db');

async function getValidToken(email) {
  const result = await sql`SELECT * FROM gmail_tokens WHERE email = ${email}`;
  if (result.rows.length === 0) throw new Error('Gmail not connected');
  return result.rows[0].access_token;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { email, messageId, action } = req.body;

  if (!email || !messageId || !action) {
    return res.status(400).json({ error: 'email, messageId, and action are required.' });
  }

  try {
    const accessToken = await getValidToken(email);
    let body = {};
    let endpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`;
    let method = 'POST';

    switch (action) {
      case 'archive':
        // Remove from inbox
        body = { removeLabelIds: ['INBOX'] };
        break;

      case 'delete':
        // Move to trash
        endpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`;
        body = {};
        break;

      case 'mark_read':
        body = { removeLabelIds: ['UNREAD'] };
        break;

      case 'mark_unread':
        body = { addLabelIds: ['UNREAD'] };
        break;

      case 'mark_important':
        body = { addLabelIds: ['IMPORTANT'] };
        break;

      case 'mark_spam':
        body = { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] };
        break;

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    const actionRes = await fetch(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const actionData = await actionRes.json();
    if (actionData.error) throw new Error(actionData.error.message);

    console.log(`✅ Action "${action}" on message ${messageId}`);
    res.json({ success: true, action, messageId });

  } catch (err) {
    console.error('Email action error:', err.message);
    res.status(500).json({ error: err.message || 'Action failed.' });
  }
};