require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const authRoutes  = require('./routes/auth');
const gmailRoutes = require('./routes/gmail');
const { startScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0'; 

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  // Use '*' temporarily to ensure your Vercel site can connect
  origin: '*', 
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ────────────────────────────────────────────────
// Standardizing paths: Now login will be at /api/auth/login
app.use('/api/auth', authRoutes);
app.use('/api/gmail', gmailRoutes);

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Agentra MailSense',
    db_connected: !!process.env.DATABASE_URL
  });
});

app.get('/', (req, res) => res.send('Agentra MailSense API is running.'));

// ── JSON Catch-All (CRITICAL FIX) ─────────────────────────────
// This prevents the "Unexpected token T" error by sending JSON instead of HTML
app.use((req, res) => {
  res.status(404).json({ 
    error: "Not Found", 
    message: `The path ${req.originalUrl} does not exist on this server.` 
  });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.stack || err.message);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    details: err.message
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`🚀 Agentra Backend Live on ${HOST}:${PORT}`);
  if (process.env.ENABLE_SCHEDULER === 'true') {
    startScheduler();
  }
});

module.exports = app;