'use strict';

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createOAuthClient } = require('./auth');

const router = express.Router();

const MAX_FILES = parseInt(process.env.MAX_FILES || '200', 10);
const PHOTOS_PAGE_SIZE = 100;
const PHOTOS_SEARCH_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems:search';
const FILE_FIELDS =
  'nextPageToken, files(id, name, size, quotaBytesUsed, mimeType, createdTime, modifiedTime, thumbnailLink, webContentLink, webViewLink, parents)';

// Middleware: require authenticated session
function requireAuth(req, res, next) {
  if (!req.session || !req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Build an authenticated Drive client from session tokens
function getAuthClient(tokens) {
  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

// Build an authenticated Drive client from session tokens
function getDriveClient(tokens) {
  const oAuth2Client = getAuthClient(tokens);
  return google.drive({ version: 'v3', auth: oAuth2Client });
}

function parseDurationSeconds(duration) {
  if (typeof duration !== 'string') return 0;
  const normalizedDuration = duration.endsWith('s') ? duration.slice(0, -1) : duration;
  const seconds = Number.parseFloat(normalizedDuration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function estimatePhotoSize(mediaItem) {
  const metadata = mediaItem.mediaMetadata || {};
  const width = parseInt(metadata.width || '0', 10);
  const height = parseInt(metadata.height || '0', 10);
  const pixelCount = width > 0 && height > 0 ? width * height : 0;

  if ((mediaItem.mimeType || '').startsWith('video/')) {
    const duration = parseDurationSeconds(metadata.video?.duration);
    if (duration <= 0) return 0;
    return pixelCount > 0 ? Math.round(pixelCount * duration) : Math.round(duration);
  }

  return pixelCount;
}

function mapDriveFile(file) {
  const isVideo = (file.mimeType || '').startsWith('video/');

  return {
    id: file.id,
    name: file.name,
    size: parseInt(file.size || file.quotaBytesUsed || '0', 10),
    mimeType: file.mimeType,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    thumbnailLink: file.thumbnailLink || null,
    webViewLink: file.webViewLink || null,
    isVideo,
    source: 'drive',
    optimisable: isVideo,
  };
}

function mapPhotoMediaItem(mediaItem) {
  const isVideo = (mediaItem.mimeType || '').startsWith('video/');

  return {
    id: mediaItem.id,
    name: mediaItem.filename,
    size: estimatePhotoSize(mediaItem),
    mimeType: mediaItem.mimeType,
    createdTime: mediaItem.mediaMetadata?.creationTime || null,
    modifiedTime: mediaItem.mediaMetadata?.creationTime || null,
    thumbnailLink: null,
    webViewLink: mediaItem.productUrl || null,
    isVideo,
    source: 'photos',
    optimisable: isVideo,
  };
}

async function fetchPhotoCandidates(tokens, candidateCount) {
  const oAuth2Client = getAuthClient(tokens);
  const mediaItems = [];
  let nextPageToken;

  try {
    while (mediaItems.length < candidateCount) {
      const { token: accessToken } = await oAuth2Client.getAccessToken();
      const response = await axios.post(
        PHOTOS_SEARCH_URL,
        {
          pageSize: Math.min(PHOTOS_PAGE_SIZE, candidateCount - mediaItems.length),
          ...(nextPageToken ? { pageToken: nextPageToken } : {}),
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const items = response.data.mediaItems || [];
      mediaItems.push(...items);

      if (!response.data.nextPageToken || items.length === 0) {
        break;
      }

      nextPageToken = response.data.nextPageToken;
    }
  } catch (err) {
    const apiMessage = err.response?.data?.error?.message;
    throw new Error(apiMessage || err.message);
  }

  console.log('Photos Library API media items fetched:', mediaItems.length);
  return mediaItems.map(mapPhotoMediaItem);
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
    const drivePageSize = pageToken ? pageSize : Math.min(MAX_FILES, pageSize * 4);

    const driveResponse = await drive.files.list({
      corpora: 'user',
      includeItemsFromAllDrives: false,
      pageSize: drivePageSize,
      pageToken,
      orderBy: 'quotaBytesUsed desc',
      fields: FILE_FIELDS,
      q: 'trashed = false',
    });
    console.log('Drive API responses:', driveResponse.data.files.length);

    const driveFiles = (driveResponse.data.files || []).map(mapDriveFile);

    let photoFiles = [];
    if (!pageToken) {
      photoFiles = await fetchPhotoCandidates(req.session.tokens, drivePageSize);
    }

    const files = [...driveFiles, ...photoFiles].sort((a, b) => b.size - a.size).slice(0, pageSize);

    return res.json({
      files,
      nextPageToken: driveResponse.data.nextPageToken || null,
    });
  } catch (err) {
    const apiError = err.response?.data?.error?.message || err.message;
    const errorDetails = err.response?.data?.error || {};
    const statusCode = err.response?.status || 500;
    console.error('Drive files error:', apiError, errorDetails);
    
    // Return appropriate HTTP status: 403 for auth errors, 500 for other errors
    const responseStatus = statusCode === 403 ? 403 : 500;
    return res.status(responseStatus).json({ error: 'Failed to list Drive files', details: apiError });
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
