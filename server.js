app.get("/", (req, res) => {
  res.send("Agentra MailSense API is running");
});

require('dotenv').config();
const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const bcrypt     = require('bcrypt');
const Database   = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ════════════════════════════════════════
//  SQLITE DATABASE
// ════════════════════════════════════════
const db = new Database('agentra.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name  TEXT NOT NULL,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT DEFAULT 'User',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
console.log('✅ SQLite database ready → agentra.db');

// ════════════════════════════════════════
//  EMAIL TRANSPORTER
// ════════════════════════════════════════
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});
transporter.verify((err) => {
  if (err) console.error('❌ Email error:', err.message);
  else     console.log('✅ Email server connected!');
});

// ════════════════════════════════════════
//  OTP STORE (in-memory)
//  Used for: signup verification + forgot password
// ════════════════════════════════════════
const otpStore = {};

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function buildEmailHTML(otp, email, type = 'signup') {
  const isSignup = type === 'signup';
  const title    = isSignup ? 'Verify Your Email' : 'Password Reset Code';
  const message  = isSignup
    ? 'You\'re almost there! Use the code below to verify your email and complete your Agentra MailSense account setup.'
    : 'You requested a password reset. Use the code below to verify your identity.';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <style>
    body{margin:0;padding:0;background:#07090f;font-family:'Helvetica Neue',Arial,sans-serif;}
    .wrap{max-width:480px;margin:40px auto;}
    .card{background:#0f1525;border:1px solid rgba(99,130,255,0.2);border-radius:16px;overflow:hidden;}
    .bar{height:3px;background:linear-gradient(90deg,#4f6ef7,#2dd4bf);}
    .body{padding:36px 40px;}
    .logo{display:flex;align-items:center;gap:10px;margin-bottom:28px;}
    .icon{width:40px;height:40px;background:linear-gradient(135deg,#4f6ef7,#2dd4bf);border-radius:10px;display:flex;align-items:center;justify-content:center;}
    .brand{font-size:1.1rem;font-weight:600;color:#e2e8f8;}
    .prod{font-size:0.65rem;color:#2dd4bf;letter-spacing:0.1em;text-transform:uppercase;}
    h2{font-size:1.3rem;color:#e2e8f8;margin:0 0 8px;font-weight:400;}
    p{font-size:0.88rem;color:#7a85a8;line-height:1.6;margin:0 0 20px;}
    .otp-box{background:#141b2e;border:1.5px solid rgba(79,110,247,0.3);border-radius:12px;padding:24px;text-align:center;margin:20px 0;}
    .code{font-size:2.4rem;font-weight:700;letter-spacing:0.2em;color:#e2e8f8;font-family:'Courier New',monospace;}
    .exp{font-size:0.76rem;color:#7a85a8;margin-top:8px;}
    .warn{background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:12px 16px;font-size:0.78rem;color:#f59e0b;}
    .footer{padding:16px 40px;border-top:1px solid rgba(99,130,255,0.1);font-size:0.72rem;color:#3a4260;text-align:center;}
  </style></head><body>
  <div class="wrap"><div class="card">
    <div class="bar"></div>
    <div class="body">
      <div class="logo">
        <div class="icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="16" height="12" rx="2" stroke="white" stroke-width="1.8" fill="none"/><path d="M2 8l8 5 8-5" stroke="white" stroke-width="1.8" stroke-linecap="round"/><path d="M19 3l1.5 3L23 7.5 20.5 9 19 12l-1.5-3L15 7.5 17.5 6 19 3z" fill="white" opacity="0.9"/></svg></div>
        <div><div class="brand">Agentra</div><div class="prod">MailSense</div></div>
      </div>
      <h2>${title}</h2>
      <p>${message} This code expires in <strong style="color:#e2e8f8">10 minutes</strong>.</p>
      <div class="otp-box">
        <div class="code">${otp}</div>
        <div class="exp">⏱ Expires in 10 minutes</div>
      </div>
      <p>If you didn't request this, you can safely ignore this email.</p>
      <div class="warn">⚠️ Never share this code with anyone. Agentra will never ask for your OTP.</div>
    </div>
    <div class="footer">Sent to ${email} · Agentra MailSense © 2025</div>
  </div></div></body></html>`;
}

// ════════════════════════════════════════
//  ROUTE: POST /signup/send-otp
//  Step 1 of signup — send OTP to verify email
// ════════════════════════════════════════
app.post('/signup/send-otp', async (req, res) => {
  const { first_name, last_name, email, password } = req.body;

  if (!first_name || !last_name || !email || !password)
    return res.status(400).json({ error: 'All fields are required.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  // Check email not already registered
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing)
    return res.status(409).json({ error: 'An account with this email already exists.' });

  // Rate limit: 1 OTP per 60 seconds
  const existingOTP = otpStore[`signup_${email}`];
  if (existingOTP) {
    const wait = Math.ceil(60 - (Date.now() - existingOTP.lastSentAt) / 1000);
    if (wait > 0) return res.status(429).json({ error: `Please wait ${wait}s before requesting again.` });
  }

  const otp = generateOTP();

  // Store OTP + user details temporarily (until verified)
  otpStore[`signup_${email}`] = {
    otp,
    expiresAt:   Date.now() + 10 * 60 * 1000,
    attempts:    0,
    lastSentAt:  Date.now(),
    // Store pending user data
    first_name,
    last_name,
    password, // will be hashed on verify
  };

  try {
    await transporter.sendMail({
      from: `"Agentra MailSense" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `${otp} — Verify your Agentra MailSense account`,
      html: buildEmailHTML(otp, email, 'signup'),
    });
    console.log(`✅ Signup OTP sent → ${email}`);
    res.json({ success: true, message: 'Verification code sent to your email!' });
  } catch (err) {
    delete otpStore[`signup_${email}`];
    console.error('Email error:', err.message);
    res.status(500).json({ error: 'Failed to send verification email. Check your .env config.' });
  }
});

// ════════════════════════════════════════
//  ROUTE: POST /signup/verify-otp
//  Step 2 of signup — verify OTP and create account
// ════════════════════════════════════════
app.post('/signup/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp)
    return res.status(400).json({ error: 'Email and verification code are required.' });

  const record = otpStore[`signup_${email}`];

  // No OTP found
  if (!record)
    return res.status(400).json({ error: 'No verification code found. Please request a new one.' });

  // Expired
  if (Date.now() > record.expiresAt) {
    delete otpStore[`signup_${email}`];
    return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
  }

  // Too many wrong attempts
  if (record.attempts >= 5) {
    delete otpStore[`signup_${email}`];
    return res.status(400).json({ error: 'Too many wrong attempts. Please request a new code.' });
  }

  // Wrong OTP
  if (record.otp !== otp.toString().trim()) {
    otpStore[`signup_${email}`].attempts++;
    const left = 5 - otpStore[`signup_${email}`].attempts;
    return res.status(400).json({
      error: `Invalid verification code. ${left} attempt${left !== 1 ? 's' : ''} remaining.`
    });
  }

  // ✅ OTP correct — create account now
  try {
    const hashed = await bcrypt.hash(record.password, 10);
    db.prepare('INSERT INTO users (first_name, last_name, email, password) VALUES (?, ?, ?, ?)')
      .run(record.first_name, record.last_name, email, hashed);

    delete otpStore[`signup_${email}`]; // clean up
    console.log(`✅ Account created: ${email}`);

    res.json({ success: true, message: 'Account created successfully! You can now sign in.' });
  } catch (err) {
    console.error('Create account error:', err.message);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});

// ════════════════════════════════════════
//  ROUTE: POST /login
// ════════════════════════════════════════
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user)
    return res.status(401).json({ error: 'No account found with this email.' });

  const match = await bcrypt.compare(password, user.password);
  if (!match)
    return res.status(401).json({ error: 'Incorrect password. Please try again.' });

  console.log(`✅ Login: ${email}`);
  res.json({
    success: true,
    user: { email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role }
  });
});

// ════════════════════════════════════════
//  ROUTE: POST /forgot/send-otp
// ════════════════════════════════════════
app.post('/forgot/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ success: true, message: 'If this email exists, a code has been sent.' });

  const existing = otpStore[`forgot_${email}`];
  if (existing) {
    const wait = Math.ceil(60 - (Date.now() - existing.lastSentAt) / 1000);
    if (wait > 0) return res.status(429).json({ error: `Please wait ${wait}s before requesting again.` });
  }

  const otp = generateOTP();
  otpStore[`forgot_${email}`] = {
    otp, expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0, lastSentAt: Date.now(), verified: false
  };

  try {
    await transporter.sendMail({
      from: `"Agentra MailSense" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `${otp} — Your Agentra MailSense Reset Code`,
      html: buildEmailHTML(otp, email, 'reset'),
    });
    console.log(`✅ Reset OTP → ${email}`);
    res.json({ success: true, message: 'If this email exists, a code has been sent.' });
  } catch (err) {
    delete otpStore[`forgot_${email}`];
    res.status(500).json({ error: 'Failed to send email. Check your .env config.' });
  }
});

// ════════════════════════════════════════
//  ROUTE: POST /forgot/verify-otp
// ════════════════════════════════════════
app.post('/forgot/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required.' });

  const record = otpStore[`forgot_${email}`];
  if (!record) return res.status(400).json({ error: 'No code found. Please request a new one.' });
  if (Date.now() > record.expiresAt) { delete otpStore[`forgot_${email}`]; return res.status(400).json({ error: 'Code expired. Please request a new one.' }); }
  if (record.attempts >= 5) { delete otpStore[`forgot_${email}`]; return res.status(400).json({ error: 'Too many attempts. Please request a new code.' }); }

  if (record.otp !== otp.toString().trim()) {
    otpStore[`forgot_${email}`].attempts++;
    const left = 5 - otpStore[`forgot_${email}`].attempts;
    return res.status(400).json({ error: `Invalid verification code. ${left} attempt${left !== 1 ? 's' : ''} remaining.` });
  }

  otpStore[`forgot_${email}`].verified = true;
  otpStore[`forgot_${email}`].verifiedAt = Date.now();
  console.log(`✅ Forgot-pw OTP verified: ${email}`);
  res.json({ success: true, message: 'Identity verified! You can now set a new password.' });
});

// ════════════════════════════════════════
//  ROUTE: POST /forgot/reset-password
// ════════════════════════════════════════
app.post('/forgot/reset-password', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and new password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const record = otpStore[`forgot_${email}`];
  if (!record || !record.verified) return res.status(403).json({ error: 'Please verify your identity first.' });
  if (Date.now() - record.verifiedAt > 10 * 60 * 1000) {
    delete otpStore[`forgot_${email}`];
    return res.status(403).json({ error: 'Session expired. Please start over.' });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hashed, email);
    delete otpStore[`forgot_${email}`];
    console.log(`✅ Password reset: ${email}`);
    res.json({ success: true, message: 'Password updated! You can now sign in.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password. Try again.' });
  }
});

// ════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════
app.get('/health', (req, res) => {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) + 's', users: count });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
// Clean expired OTPs every 5 mins
setInterval(() => {
  const now = Date.now();
  for (const e in otpStore) if (now > otpStore[e].expiresAt) delete otpStore[e];
}, 5 * 60 * 1000);