// backend/server.js
// ─────────────────────────────────────────────────────────────
//   Agentra MailSense – Production Optimized (Railway + Vercel)
// ─────────────────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

// Route modules
const authRoutes  = require('./routes/auth');
const gmailRoutes = require('./routes/gmail');

// Scheduler (server-side auto-delete)
const { startScheduler } = require('./scheduler');

const app  = express();

// IMPORTANT: Railway provides the PORT, but we must also bind to 0.0.0.0
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0'; 

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  // When deployed, process.env.APP_URL should be your Vercel URL
  origin: process.env.NODE_ENV === 'production'
    ? process.env.APP_URL
    : '*',
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API Routes ────────────────────────────────────────────────
app.use('/api', authRoutes);
app.use('/api', gmailRoutes);

// ── Health check (Crucial for Railway Deployment) ─────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Agentra MailSense',
    timestamp: new Date().toISOString(),
    node_env: process.env.NODE_ENV,
    db_connected: !!process.env.DATABASE_URL // Simple check if DB variable is present
  });
});

// Root route for Railway (Prevents 404 on the base URL)
app.get('/', (req, res) => {
  res.send('Agentra MailSense API is running.');
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.stack || err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Agentra MailSense – Server Running     ║
  ║   Port: ${PORT}                           ║
  ║   Host: ${HOST}                        ║
  ╚══════════════════════════════════════════╝
  `);

  // Start background scheduler
  if (process.env.ENABLE_SCHEDULER === 'true') {
    startScheduler();
  }
});

module.exports = app;