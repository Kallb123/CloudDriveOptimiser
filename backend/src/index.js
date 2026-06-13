'use strict';

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const authRouter = require('./auth');
const driveRouter = require('./drive');
const optimiseRouter = require('./optimise');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const isProd = process.env.NODE_ENV === 'production';
const { version: VERSION } = require("../package.json");


console.log(`[cloud-drive-optimiser] v${VERSION} starting`);

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    httpOnly: true,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// ── CSRF protection (synchronizer token pattern) ────────────────
// GET /csrf-token — issues a token stored in the session
app.get('/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.json({ csrfToken: req.session.csrfToken });
});

// Middleware: validate CSRF token for all state-changing requests
function csrfProtection(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();
  const token = req.headers['x-csrf-token'];
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
}

app.use('/auth/logout', csrfProtection);
app.use('/api', csrfProtection);

// ── Rate limiting ──────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/auth', authLimiter);
app.use('/api', apiLimiter);

// ── Routers ────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/api/drive', driveRouter);
app.use('/api/optimise', optimiseRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

module.exports = app;
