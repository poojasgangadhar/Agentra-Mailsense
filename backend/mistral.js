// backend/mistral.js — Mistral AI + classifier
const fetch = require('node-fetch');

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

// Read keys dynamically so Vercel env vars are always picked up at runtime
function getMistralKey()   { return process.env.MISTRAL_API_KEY || ''; }
function getMistralModel() { return process.env.MISTRAL_MODEL   || 'mistral-small-latest'; }

async function mistralChat(messages, maxTokens = 300) {
  const MISTRAL_API_KEY = getMistralKey();
  const MISTRAL_MODEL   = getMistralModel();
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY not set');
  const res = await fetch(MISTRAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: MISTRAL_MODEL, messages, max_tokens: maxTokens, temperature: 0.4 }),
  });
  if (!res.ok) throw new Error(`Mistral API ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// ── Self-sent-email detection ──────────────────────────────────
function isSelfSent(fromAddr = '', userOwnEmail = '') {
  if (!userOwnEmail || !fromAddr) return false;
  const addr = (fromAddr.match(/<(.+?)>/) || [])[1] || fromAddr;
  return addr.trim().toLowerCase() === userOwnEmail.trim().toLowerCase();
}

// ── No-reply / automated sender detection ─────────────────────
const NO_REPLY_PATTERNS = [
  // Generic no-reply patterns
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notifications@', 'notification@', 'alerts@', 'alert@',
  'mailer@', 'mailer-daemon', 'postmaster@', 'bounce@',
  'automated@', 'system@', 'robot@', 'daemon@',
  'accounts-noreply@', 'mail-noreply@',
  // Job/social platforms — these never need replies
  'naukri', 'linkedin', 'github', 'instagram', 'facebook', 'twitter',
  'youtube', 'google', 'amazon', 'flipkart', 'swiggy', 'zomato',
  'paytm', 'phonepe', 'razorpay', 'stripe', 'paypal',
  'indeed', 'glassdoor', 'monster', 'internshala', 'apna',
  // Common automated senders
  'info@', 'support@', 'hello@', 'team@', 'contact@',
  'newsletter@', 'news@', 'updates@', 'update@', 'digest@',
  'marketing@', 'promo@', 'deals@', 'offers@', 'billing@',
];

const NO_REPLY_SUBJECTS = [
  // OTP / security
  'otp', 'verification code', 'one-time password', 'security code',
  'password reset', 'reset your password', 'two-factor', '2fa',
  'login attempt', 'new sign-in', 'security alert', 'verify your',
  'confirm your', 'account verification', 'email verification',
  // Automated messages
  'do not reply', 'do not respond', 'automated message',
  'automatic reply', 'this is an automated', 'auto-reply',
  // Job/social platform notifications
  'applied to', 'job alert', 'new job', 'recruiter', 'viewed your profile',
  'connection request', 'new follower', 'liked your', 'commented on',
  'new notification', 'activity on', 'digest', 'weekly update',
  'monthly update', 'your weekly', 'your monthly',
  // Transactional
  'your order', 'order confirmed', 'order shipped', 'delivery',
  'payment received', 'payment confirmed', 'transaction',
  'invoice', 'receipt', 'statement', 'subscription',
  // Notifications from platforms
  'new message on', 'someone replied', 'you have a new',
  'push notification', 'app notification',
];

function isNoReplyEmail(fromAddr = '', subject = '', snippet = '') {
  const addr = fromAddr.toLowerCase();
  const subj = subject.toLowerCase();
  const snip = snippet.toLowerCase();

  if (NO_REPLY_PATTERNS.some(p => addr.includes(p))) return true;
  if (NO_REPLY_SUBJECTS.some(p => subj.includes(p))) return true;
  if (snip.includes('do not reply') || snip.includes('do not respond') ||
      snip.includes('this is an automated') || snip.includes('automated message')) return true;

  return false;
}

// ── Rule-based fallback (only used if Mistral is unavailable) ──
const SPAM_KEYWORDS = [
  'winner','won','lottery','prize','claim now','urgent action',
  'account suspended','verify immediately','free money','wire transfer',
  'nigerian','inheritance','bitcoin investment','act now','selected',
  'congratulations you','limited offer expires','click here to claim',
];
const PROMO_KEYWORDS = [
  'sale','% off','coupon','promo code','newsletter','marketing',
  'shop now','buy now','flash sale','clearance',
  'unsubscribe','weekly digest','daily deals','special offer',
  'discount','deal of the day','limited time',
];
const PLATFORM_SENDERS = [
  'naukri', 'linkedin', 'github', 'instagram', 'facebook', 'twitter',
  'youtube', 'google', 'amazon', 'flipkart', 'swiggy', 'zomato',
  'paytm', 'phonepe', 'razorpay', 'stripe', 'paypal', 'indeed',
  'glassdoor', 'monster', 'internshala', 'shine.com', 'apna',
];

const PLATFORM_SUBJECTS = [
  'otp', 'verification code', 'one-time password', 'security code',
  'verify your', 'confirm your account', 'password reset', 'reset your password',
  'security alert', 'new sign-in', 'login attempt', 'two-factor', '2fa',
  'invoice', 'receipt', 'payment confirmation', 'order confirmation',
  'shipping update', 'delivery notification', 'tracking update',
  'job alert', 'new job', 'recruiter viewed', 'applied to',
  'new follower', 'liked your', 'commented on', 'connection request',
  'weekly digest', 'monthly digest', 'your activity',
];

function ruleBasedClassify(subject = '', snippet = '', fromAddr = '', userOwnEmail = '') {
  if (isSelfSent(fromAddr, userOwnEmail)) return 'important';

  const text = `${subject} ${snippet} ${fromAddr}`.toLowerCase();
  const spamScore = SPAM_KEYWORDS.filter(k => text.includes(k)).length;
  if (spamScore >= 2) return 'spam';

  // Platform/service emails → promo
  if (PLATFORM_SENDERS.some(k => text.includes(k))) return 'promo';
  if (PLATFORM_SUBJECTS.some(k => text.includes(k))) return 'promo';

  const promoScore = PROMO_KEYWORDS.filter(k => text.includes(k)).length;
  if (promoScore >= 1) return 'promo';

  return 'important';
}

// ── Classify email ────────────────────────────────────────────
async function classifyEmail({ subject, snippet, fromAddr, fromName, userOwnEmail }) {
  if (isSelfSent(fromAddr, userOwnEmail)) return 'important';

  if (!getMistralKey()) {
    return ruleBasedClassify(subject, snippet, fromAddr, userOwnEmail);
  }

  const messages = [
    {
      role: 'system',
      content:
        'You are an email classifier. Classify emails as exactly one of: important, promo, or spam.\n\n' +
        'IMPORTANT: Emails that require a human reply from the user — personal messages, work emails, direct questions, client emails, colleague messages, interview calls, collaboration requests.\n\n' +
        'PROMO: All automated/system/platform emails that do NOT need a reply — OTPs, verification codes, password resets, security alerts, login notifications, job alerts from Naukri/LinkedIn/Indeed, social media notifications (Instagram/Facebook/Twitter/GitHub), order confirmations, invoices, receipts, payment confirmations, shipping updates, newsletters, digests, weekly updates, app notifications, promotional offers, discount emails, any email from a platform or service.\n\n' +
        'SPAM: Phishing, scams, unsolicited junk, lottery/prize emails, suspicious links.\n\n' +
        'KEY RULE: If the email is from a platform/service/app (not a real person writing directly to the user), classify as PROMO. Only classify as IMPORTANT if a real human is directly writing to the user expecting a reply.\n\n' +
        'Respond with ONE word only: important, promo, or spam.',
    },
    {
      role: 'user',
      content: `From: ${fromName || ''} <${fromAddr || ''}>\nSubject: ${subject || '(no subject)'}\nPreview: ${snippet || ''}`,
    },
  ];

  try {
    const result = await mistralChat(messages, 10);
    const clean  = result.toLowerCase().replace(/[^a-z]/g, '');
    if (['important', 'promo', 'spam'].includes(clean)) return clean;
    return ruleBasedClassify(subject, snippet, fromAddr, userOwnEmail);
  } catch (err) {
    console.error('[Mistral] classify error:', err.message);
    return ruleBasedClassify(subject, snippet, fromAddr, userOwnEmail);
  }
}

// ── Generate reply ────────────────────────────────────────────
// IMPORTANT: senderFirstName / senderLastName must be the user's
// actual signup name pulled from the DB by the caller (e.g. the
// route handler that has access to req.user). This function will
// NOT invent a name, and will never emit a bracketed placeholder
// like "[Your Name]" — if no real name is supplied, it falls back
// to a generic sign-off with no name at all rather than a placeholder.
function buildSignOff(senderFirstName, senderLastName) {
  const first = (senderFirstName || '').trim();
  const last  = (senderLastName || '').trim();
  const full  = [first, last].filter(Boolean).join(' ');
  return full; // '' if neither was provided
}

async function generateReply({
  subject,
  snippet,
  fromName,
  replyTemplate,
  customContext,
  senderFirstName,
  senderLastName,
}) {
  const signOff = buildSignOff(senderFirstName, senderLastName);
  const closing = signOff ? `Best regards,\n${signOff}` : 'Best regards';

  if (!getMistralKey()) {
    return replyTemplate ||
      `Hi ${fromName || 'there'},\n\nThank you for your email. I'll get back to you shortly.\n\n${closing}`;
  }

  const contextNote = customContext ? `\nAdditional context from user: ${customContext}` : '';

  // Build the sign-off instruction without ever exposing a
  // placeholder-shaped fallback string to the model.
  const signOffInstruction = signOff
    ? `- End the reply with exactly: "Best regards,\\n${signOff}" — use this exact name, do not alter it, do not invent a different name.`
    : `- End the reply with exactly: "Best regards," with nothing after it on the next line — no name, and absolutely no placeholder text such as "[Your Name]", "[Sender Name]", "[Company]", or similar bracketed text.`;

  const messages = [
    {
      role: 'system',
      content:
        'You are a professional email assistant writing personalized auto-replies.\n' +
        'Rules:\n' +
        '- Write 2-4 sentences tailored specifically to the email content\n' +
        '- Reference the actual subject or content of their email\n' +
        '- Sound natural and human, not generic\n' +
        '- Do NOT use placeholder text like [Your Name], [Sender Name], or [Company] under any circumstance\n' +
        '- Do NOT include subject line\n' +
        signOffInstruction + '\n' +
        '- Every reply must be UNIQUE and specific to this email',
    },
    {
      role: 'user',
      content: `Write a personalized auto-reply for this email:\nFrom: ${fromName || 'Unknown'}\nSubject: ${subject || '(no subject)'}\nContent: ${snippet || '(no preview)'}${contextNote}`,
    },
  ];

  try {
    let reply = await mistralChat(messages, 250);

    // Hard safety net: if the model still slips in a bracketed
    // placeholder, strip it and re-append the real (or name-less) closing.
    if (/\[\s*(your|sender'?s?)\s*name\s*\]/i.test(reply) || /\[\s*company\s*\]/i.test(reply)) {
      reply = reply.replace(/best regards,?[\s\S]*$/i, '').trim();
      reply = `${reply}\n\n${closing}`;
    }

    if (reply && reply.length > 20) return reply;
    return replyTemplate ||
      `Hi ${fromName || 'there'},\n\nThank you for reaching out regarding "${subject}". I'll review this and get back to you shortly.\n\n${closing}`;
  } catch (err) {
    console.error('[Mistral] generateReply error:', err.message);
    return replyTemplate ||
      `Hi ${fromName || 'there'},\n\nThank you for reaching out regarding "${subject}". I'll get back to you shortly.\n\n${closing}`;
  }
}

module.exports = { classifyEmail, generateReply, isNoReplyEmail };
