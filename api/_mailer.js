// api/_mailer.js — shared email helper
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function buildEmailHTML(otp, email, type = 'signup') {
  const isSignup = type === 'signup';
  const title   = isSignup ? 'Verify Your Email' : 'Password Reset Code';
  const message = isSignup
    ? "You're almost there! Use the code below to verify your email and complete your Agentra MailSense account setup."
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
      <div class="warn">⚠️ Never share this code with anyone.</div>
    </div>
    <div class="footer">Sent to ${email} · Agentra MailSense © 2025</div>
  </div></div></body></html>`;
}

async function sendOTP(to, otp, type = 'signup') {
  const subject = type === 'signup'
    ? `${otp} — Verify your Agentra MailSense account`
    : `${otp} — Your Agentra MailSense Reset Code`;

  await transporter.sendMail({
    from: `"Agentra MailSense" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html: buildEmailHTML(otp, to, type),
  });
}

module.exports = { generateOTP, sendOTP };