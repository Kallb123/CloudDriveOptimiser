'use strict';

const express = require('express');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || `${BACKEND_URL}/auth/google/callback`;

function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

// GET /auth/google — redirect user to Google consent screen
router.get('/google', (_req, res) => {
  const oAuth2Client = createOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.photos.readonly',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
  res.redirect(authUrl);
});

// GET /auth/google/callback — handle OAuth callback
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    console.error('OAuth callback error:', error || 'No code provided');
    return res.redirect(`${FRONTEND_URL}/?error=auth_failed`);
  }
  try {
    const oAuth2Client = createOAuthClient();
    console.log('Exchanging code for tokens...');
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Fetch basic user profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    console.log('Fetching user profile...');
    const { data: profile } = await oauth2.userinfo.get();

    req.session.tokens = tokens;
    req.session.user = {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      picture: profile.picture,
    };

    console.log('User authenticated:', req.session.user);
    console.log('Session ID on callback:', req.sessionID);

    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
        return res.redirect(`${FRONTEND_URL}/?error=auth_failed`);
      }
      return res.redirect(`${FRONTEND_URL}/`);
    });
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    return res.redirect(`${FRONTEND_URL}/?error=auth_failed`);
  }
});

// GET /auth/status — return current session user or 401
router.get('/status', (req, res) => {
  console.log('Session ID on status:', req.sessionID);
  console.log('Session status check:', req.session.user ? 'Authenticated' : 'Not authenticated');
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  console.log('User not authenticated, returning 401', req.session);
  return res.status(401).json({ authenticated: false });
});

// POST /auth/logout — destroy session
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
    }
    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

module.exports = router;
module.exports.createOAuthClient = createOAuthClient;
