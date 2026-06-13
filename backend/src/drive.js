'use strict';

const express = require('express');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createOAuthClient } = require('./auth');

const router = express.Router();

const MAX_FILES = parseInt(process.env.MAX_FILES || '200', 10);

// Middleware: require authenticated session
function requireAuth(req, res, next) {
  if (!req.session || !req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Build an authenticated Drive client from session tokens
function getDriveClient(tokens) {
  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials(tokens);
  return google.drive({ version: 'v3', auth: oAuth2Client });
}

/**
 * GET /api/drive/files
 * Returns files sorted by size descending.
 * Query params:
 *   pageToken - for pagination
 *   pageSize   - number of results (default 50, max MAX_FILES)
 */
router.get('/files', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.session.tokens);
    const pageSize = Math.min(parseInt(req.query.pageSize || '50', 10), MAX_FILES);
    const pageToken = req.query.pageToken || undefined;

    const response = await drive.files.list({
      pageSize,
      pageToken,
      orderBy: 'quotaBytesUsed desc',
      fields:
        'nextPageToken, files(id, name, size, mimeType, createdTime, modifiedTime, thumbnailLink, webContentLink, webViewLink, parents)',
      q: 'trashed = false',
    });

    const files = (response.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size ? parseInt(f.size, 10) : 0,
      mimeType: f.mimeType,
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      thumbnailLink: f.thumbnailLink || null,
      webViewLink: f.webViewLink || null,
      isVideo: (f.mimeType || '').startsWith('video/'),
    }));

    return res.json({
      files,
      nextPageToken: response.data.nextPageToken || null,
    });
  } catch (err) {
    console.error('Drive files error:', err.message);
    return res.status(500).json({ error: 'Failed to list Drive files' });
  }
});

/**
 * GET /api/drive/thumbnail/:fileId
 * Proxies the thumbnail image through the backend so the browser can
 * display it without exposing the user's access token in the URL.
 */
router.get('/thumbnail/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.session.tokens);
    const { data: meta } = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'thumbnailLink',
    });

    if (!meta.thumbnailLink) {
      return res.status(404).json({ error: 'No thumbnail available' });
    }

    // Fetch thumbnail and pipe to response
    const axios = require('axios');
    const imgResponse = await axios.get(meta.thumbnailLink, { responseType: 'stream' });
    res.setHeader('Content-Type', imgResponse.headers['content-type'] || 'image/jpeg');
    imgResponse.data.pipe(res);
  } catch (err) {
    console.error('Thumbnail error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch thumbnail' });
  }
});

module.exports = router;
module.exports.getDriveClient = getDriveClient;
module.exports.requireAuth = requireAuth;
