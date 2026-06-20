'use strict';

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');
const redisClient = require('./redis-client');
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

async function getPhotosAccessToken(tokens) {
  const authClient = createOAuthClient();
  authClient.setCredentials(tokens);
  const accessTokenResponse = await authClient.getAccessToken();
  const accessToken = accessTokenResponse?.token || accessTokenResponse;

  if (!accessToken) {
    throw new Error('Unable to obtain a valid Google access token for Photos API requests.');
  }

  return accessToken;
}

async function getOrCreatePhotosAlbum(tokens, userId) {
  const redisKey = `photos_album:${userId}`;
  const existingAlbumId = await redisClient.get(redisKey);
  if (existingAlbumId) {
    console.log(`[auth] found existing photos album ID in Redis for user ${userId}: ${existingAlbumId}`);
    return existingAlbumId;
  }

  console.log(`[auth] no existing photos album found in Redis for user ${userId}, creating one`);
  const accessToken = await getPhotosAccessToken(tokens);

  const response = await axios.post(
    'https://photoslibrary.googleapis.com/v1/albums',
    { album: { title: 'Cloud Drive Optimiser' } },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const albumId = response.data?.id;
  if (!albumId) {
    throw new Error('Failed to create Google Photos album');
  }

  await redisClient.set(redisKey, albumId);
  console.log(`[auth] created new photos album ${albumId} and stored it in Redis for user ${userId}`);

  return albumId;
}

// GET /auth/google — redirect user to Google consent screen
router.get('/google', (_req, res) => {
  const oAuth2Client = createOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
      'https://www.googleapis.com/auth/photoslibrary.appendonly',
      'https://www.googleapis.com/auth/photoslibrary.readonly',
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

    try {
      const albumId = await getOrCreatePhotosAlbum(tokens, profile.id);
      req.session.photosAlbumId = albumId;
      console.log(`[auth] photos album ID saved to session for user ${profile.id}: ${albumId}`);
    } catch (albumErr) {
      console.error('[auth] failed to retrieve or create photos album:', albumErr.message);
      // Continue without blocking auth: session still valid, album can be created later.
    }

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
router.get('/status', async (req, res) => {
  console.log('Session ID on status:', req.sessionID);
  console.log('Session status check:', req.session.user ? 'Authenticated' : 'Not authenticated');

  if (req.session && req.session.user) {
    if (!req.session.photosAlbumId && req.session.tokens && req.session.user.id) {
      try {
        const albumId = await getOrCreatePhotosAlbum(req.session.tokens, req.session.user.id);
        req.session.photosAlbumId = albumId;
        await new Promise((resolve, reject) => {
          req.session.save((saveErr) => {
            if (saveErr) return reject(saveErr);
            resolve();
          });
        });
        console.log(`[auth] photos album ID saved to session on status route for user ${req.session.user.id}: ${albumId}`);
      } catch (albumErr) {
        console.error('[auth] failed to fetch or create photos album on status:', albumErr.message);
      }
    }

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
