// api/emails/reply.js
// Sends reply (Fast Mode) or saves draft (Safe Mode)

const { sql } = require('../_db');

async function getValidToken(email) {
  const result = await sql`SELECT * FROM gmail_tokens WHERE email = ${email}`;
  if (result.rows.length === 0) throw new Error('Gmail not connected');
  return result.rows[0].access_token;
}

function makeReplyRaw(to, subject, body, threadId) {
  const message = [
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join('\n');

  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { email, to, subject, body, threadId, mode = 'safe' } = req.body;

  if (!email || !to || !body) {
    return res.status(400).json({ error: 'email, to, and body are required.' });
  }

  try {
    const accessToken = await getValidToken(email);
    const raw = makeReplyRaw(to, subject || '', body, threadId);

    if (mode === 'fast') {
      // FAST MODE — send immediately
      const sendRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            raw,
            threadId,
          }),
        }
      );
      const sendData = await sendRes.json();
      if (sendData.error) throw new Error(sendData.error.message);

      console.log(`✅ Fast Mode: Reply sent → ${to}`);
      res.json({ success: true, mode: 'fast', messageId: sendData.id, message: 'Reply sent immediately!' });

    } else {
      // SAFE MODE — save as draft
      const draftRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/drafts`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: { raw, threadId },
          }),
        }
      );
      const draftData = await draftRes.json();
      if (draftData.error) throw new Error(draftData.error.message);

      console.log(`✅ Safe Mode: Draft saved for → ${to}`);
      res.json({ success: true, mode: 'safe', draftId: draftData.id, message: 'Reply saved as draft for review.' });
    }

  } catch (err) {
    console.error('Reply error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send reply.' });
  }
};