'use strict';

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createOAuthClient } = require('./auth');

const router = express.Router();

const MAX_FILES = parseInt(process.env.MAX_FILES || '200', 10);
const TARGET_HEIGHT = parseInt(process.env.TRANSCODE_HEIGHT || '720', 10);
const FILE_FIELDS =
  'nextPageToken, files(id, name, size, quotaBytesUsed, mimeType, createdTime, modifiedTime, thumbnailLink, webContentLink, webViewLink, parents, videoMediaMetadata(width,height,durationMillis))';

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

const PHOTO_SIZE_TIMEOUT_MS = 20000;

// Total byte size of a Google Photos video, or null when it can't be read.
async function getVideoFileSize(baseUrl, accessToken) {
  if (!baseUrl) return null;
  let response;
  try {
    response = await axios.get(`${baseUrl}=dv`, {
      headers: {
        Authorization: 'Bearer ' + accessToken,
        // Ask for only the first byte of the file
        Range: 'bytes=0-0',
      },
      // Streamed so a server that ignores Range doesn't buffer the whole video
      responseType: 'stream',
      timeout: PHOTO_SIZE_TIMEOUT_MS,
    });
  } catch (error) {
    console.error(
      'Failed to fetch file size:',
      error.response?.status,
      error.response?.statusText || error.message
    );
    return null;
  }
  response.data.destroy();

  // The server responds with a header like: "bytes 0-0/15432098"
  const contentRange = response.headers['content-range'];
  const totalBytes = contentRange
    ? parseInt(String(contentRange).split('/')[1], 10)
    : parseInt(response.headers['content-length'], 10);
  return Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
}

// Returns why a file can't be optimised, or null if it can. The short side is
// compared so portrait videos are treated the same as landscape ones. Unknown
// resolution stays optimisable (the ffmpeg scale filter never upscales).
function getNotOptimisableReason(isVideo, width, height) {
  if (!isVideo) return 'Only video files can be optimised';
  if (width > 0 && height > 0 && Math.min(width, height) <= TARGET_HEIGHT) {
    return `Already ${TARGET_HEIGHT}p or lower`;
  }
  return null;
}

function mapDriveFile(file) {
  const isVideo = (file.mimeType || '').startsWith('video/');
  const width = parseInt(file.videoMediaMetadata?.width || '0', 10);
  const height = parseInt(file.videoMediaMetadata?.height || '0', 10);
  const resolution = width > 0 && height > 0 ? `${width}×${height}` : null;
  const durationMillis = parseInt(file.videoMediaMetadata?.durationMillis || '0', 10) || null;
  const notOptimisableReason = getNotOptimisableReason(isVideo, width, height);

  return {
    id: file.id,
    name: file.name,
    size: parseInt(file.size || file.quotaBytesUsed || '0', 10),
    mimeType: file.mimeType,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    thumbnailLink: file.thumbnailLink || null,
    webViewLink: file.webViewLink || null,
    width: width || null,
    height: height || null,
    resolution,
    durationMillis,
    isVideo,
    source: 'drive',
    optimisable: isVideo && !notOptimisableReason,
    alreadyOptimised: Boolean(isVideo && notOptimisableReason),
    notOptimisableReason,
  };
}

function ensurePhotoThumbnailMap(session) {
  if (!session.photoThumbnailUrls) {
    session.photoThumbnailUrls = {};
  }
  return session.photoThumbnailUrls;
}

// Maps a Picker media item for the file list. Video sizes need one request each
// to Google, so they are left null here and filled in via /picker/sizes.
function mapPhotoMediaItem(mediaItem, session) {
  const mediaFile = mediaItem.mediaFile || mediaItem;
  const metadata = mediaFile.mediaFileMetadata || mediaItem.mediaMetadata || {};
  const width = parseInt(metadata.width || '0', 10);
  const height = parseInt(metadata.height || '0', 10);
  const resolution = width > 0 && height > 0 ? `${width}×${height}` : null;
  const mimeType = mediaFile.mimeType || mediaItem.mimeType || '';
  const isVideo = mediaItem.type === 'VIDEO' || mimeType.startsWith('video/');
  const baseUrl = mediaFile.baseUrl || mediaItem.baseUrl || null;
  const notOptimisableReason = getNotOptimisableReason(isVideo, width, height);
  const thumbnailRoute = mediaItem.id && baseUrl
    ? `/api/drive/photo-thumbnail/${encodeURIComponent(mediaItem.id)}`
    : null;

  if (mediaItem.id && baseUrl && session) {
    const thumbnailUrls = ensurePhotoThumbnailMap(session);
    thumbnailUrls[mediaItem.id] = baseUrl;
  }

  return {
    id: mediaItem.id,
    name: mediaFile.filename || mediaItem.filename || mediaItem.name || mediaItem.id,
    size: null,
    mimeType,
    createdTime: mediaItem.createTime || mediaItem.mediaMetadata?.creationTime || null,
    modifiedTime: mediaItem.updateTime || mediaItem.createTime || mediaItem.mediaMetadata?.creationTime || null,
    thumbnailLink: thumbnailRoute,
    webViewLink: baseUrl || mediaItem.productUrl || null,
    width: width || null,
    height: height || null,
    resolution,
    durationMillis: null, // the Photos Picker API does not provide duration
    mediaItem,
    isVideo,
    source: 'photos',
    optimisable: isVideo && !notOptimisableReason,
    alreadyOptimised: Boolean(isVideo && notOptimisableReason),
    notOptimisableReason,
  };
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

    // Note: Google Photos videos are now selected via the Photo Picker API
    // (see /api/drive/picker/create-session and /api/drive/picker/get-items)
    const files = driveFiles.slice(0, pageSize);

    return res.json({
      files,
      nextPageToken: driveResponse.data.nextPageToken || null,
    });
  } catch (err) {
    const apiError = err.response?.data?.error?.message || err.message;
    const errorDetails = err.response?.data?.error || {};
    const statusCode = err.response?.status || 500;
    console.error('Drive files error:', apiError, errorDetails);
    
    // Determine appropriate status code and message based on error type
    let responseStatus = statusCode;
    let errorMessage = 'Failed to list Drive files';
    
    if (statusCode === 403) {
      // Check if the error is specifically about insufficient scopes using Google API error properties
      // Google API returns errors with 'reason' field for specific error types
      const isScopeError = (
        errorDetails.reason === 'insufficientPermissions' ||
        errorDetails.reason === 'forbidden' ||
        (apiError && apiError.toLowerCase().includes('insufficient') && apiError.toLowerCase().includes('scope'))
      );
      
      if (isScopeError) {
        errorMessage = 'Authentication failed: insufficient scopes. Please ensure all required scopes are configured in your Google Cloud Console OAuth consent screen (see README.md "Google Cloud Setup" section for required scopes) and re-authenticate with the application.';
      } else {
        errorMessage = 'Access denied by Google Drive API.';
      }
    } else if (statusCode === 401) {
      errorMessage = 'Authentication failed: invalid or expired credentials. Please re-authenticate.';
    } else if (statusCode >= 500) {
      responseStatus = 500;
    }
    
    const response = { error: errorMessage };
    // Only include debug details in development mode
    if (process.env.NODE_ENV !== 'production') {
      response.details = apiError;
    }
    return res.status(responseStatus).json(response);
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

/**
 * GET /api/drive/photo-thumbnail/:mediaItemId
 * Proxies Google Photos thumbnail requests through the backend so the browser
 * does not need to fetch protected photo URLs directly.
 */
router.get('/photo-thumbnail/:mediaItemId', requireAuth, async (req, res) => {
  try {
    const mediaItemId = req.params.mediaItemId;
    const thumbnailUrls = req.session.photoThumbnailUrls || {};
    const baseUrl = thumbnailUrls[mediaItemId];

    if (!baseUrl) {
      return res.status(404).json({ error: 'Thumbnail source not found' });
    }

    const oAuth2Client = getAuthClient(req.session.tokens);
    const { token: accessToken } = await oAuth2Client.getAccessToken();
    const thumbnailUrl = `${baseUrl}=w200-h200`;

    const imgResponse = await axios.get(thumbnailUrl, {
      responseType: 'stream',
      headers: {
        Authorization: 'Bearer ' + accessToken,
      },
    });

    res.setHeader('Content-Type', imgResponse.headers['content-type'] || 'image/jpeg');
    imgResponse.data.pipe(res);
  } catch (err) {
    const statusCode = err.response?.status || 500;
    const apiError = err.message || err.response?.data || 'Failed to fetch photo thumbnail';
    console.error('Photo thumbnail proxy error:', statusCode, apiError);
    return res.status(statusCode).json({
      error: 'Failed to fetch photo thumbnail',
      status: statusCode,
      details: apiError,
    });
  }
});

/**
 * POST /api/drive/picker/create-session
 * Creates a Google Photos Picker session and returns the pickerUri and sessionId.
 * The frontend opens pickerUri in a secure popup and polls the session status.
 */
router.post('/picker/create-session', requireAuth, async (req, res) => {
  try {
    const oAuth2Client = getAuthClient(req.session.tokens);
    const { token: accessToken } = await oAuth2Client.getAccessToken();

    // Call Google's photoPicker API to create a picker session
    console.log('Creating Photos Picker session', { accessTokenAvailable: Boolean(accessToken) });
    const response = await axios.post(
      'https://photospicker.googleapis.com/v1/sessions',
      {},
      {
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Photos Picker create-session response', {
      status: response.status,
      data: response.data,
    });

    const rawSessionId = response.data.sessionId || response.data.id || null;
    const sessionId = rawSessionId || (typeof response.data.name === 'string'
      ? response.data.name.split('/').pop()
      : null);
    const pickerUri = response.data.pickerUri || null;

    if (!pickerUri || !sessionId) {
      console.error('Photos Picker session creation response missing fields:', response.data);
      return res.status(500).json({
        error: 'Google Photos Picker session creation failed: missing pickerUri or sessionId',
      });
    }

    console.log('Photos Picker session created:', sessionId);
    return res.json({ pickerUri, sessionId });
  } catch (err) {
    const apiMessage = err.response?.data?.error?.message;
    console.error('Photos Picker session creation error:', apiMessage || err.message);
    return res.status(err.response?.status || 500).json({
      error: apiMessage || 'Failed to create Google Photos Picker session',
    });
  }
});

function normalizePickerSessionResource(sessionId) {
  if (!sessionId) return null;
  return sessionId.includes('sessions/') ? sessionId.replace('sessions/', '') : sessionId;
}

async function fetchPickerResult(sessionId, accessToken) {
  try {
    const sessionResource = normalizePickerSessionResource(sessionId);
    const response = await axios.get(
      'https://photospicker.googleapis.com/v1/sessions/' +
        encodeURIComponent(sessionResource),
      {
        headers: {
          Authorization: 'Bearer ' + accessToken,
        },
      }
    );
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const apiMessage = err.response?.data?.error?.message || err.message;
    console.error('Google Photos Picker getResult error', {
      sessionId,
      sessionResource: normalizePickerSessionResource(sessionId),
      status,
      apiMessage,
      responseData: err.response?.data,
      responseHeaders: err.response?.headers,
    });
    throw err;
  }
}

/**
 * POST /api/drive/picker/status
 * Polls the Google Photos Picker session. Returns done: false until the user
 * has clicked Done in the picker, plus Google's recommended poll interval.
 * The selected items are then fetched with /picker/get-items.
 */
router.post('/picker/status', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      console.error('Picker status missing sessionId in request body');
      return res.status(400).json({ error: 'Missing sessionId in request body' });
    }

    const oAuth2Client = getAuthClient(req.session.tokens);
    const { token: accessToken } = await oAuth2Client.getAccessToken();
    const resultData = await fetchPickerResult(sessionId, accessToken);
    const pollIntervalSeconds = parseDurationSeconds(resultData.pollingConfig?.pollInterval);

    return res.json({
      done: resultData.mediaItemsSet === true,
      pollIntervalMs: pollIntervalSeconds > 0 ? Math.round(pollIntervalSeconds * 1000) : null,
      expireTime: resultData.expireTime || null,
    });
  } catch (err) {
    const apiMessage = err.response?.data?.error?.message;
    console.error('Photos Picker status error:', {
      sessionId: req.body?.sessionId,
      message: apiMessage || err.message,
    });
    return res.status(err.response?.status || 500).json({
      error: apiMessage || 'Failed to fetch Google Photos Picker status',
    });
  }
});

const PICKER_PAGE_SIZE = 100; // the Picker API maximum

/**
 * POST /api/drive/picker/get-items
 * Retrieves every selected media item from the picker session (all pages).
 * Video sizes are not included; fetch them with /picker/sizes.
 */
router.post('/picker/get-items', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      console.error('Picker get-items missing sessionId in request body');
      return res.status(400).json({ error: 'Missing sessionId in request body' });
    }

    const oAuth2Client = getAuthClient(req.session.tokens);
    const { token: accessToken } = await oAuth2Client.getAccessToken();
    const sessionResource = normalizePickerSessionResource(sessionId);

    // Without paging, Google returns only the first 25 selected items.
    const mediaItems = [];
    let pageToken;
    do {
      const response = await axios.get('https://photospicker.googleapis.com/v1/mediaItems', {
        params: { sessionId: sessionResource, pageSize: PICKER_PAGE_SIZE, pageToken },
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      mediaItems.push(...(response.data.mediaItems || []));
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    const mappedItems = mediaItems.map((item) => mapPhotoMediaItem(item, req.session));

    console.log('Photos Picker items retrieved:', mappedItems.length);
    return res.json({ files: mappedItems });
  } catch (err) {
    const apiMessage = err.response?.data?.error?.message;
    console.error('Photos Picker get-items error:', {
      sessionId: req.body?.sessionId,
      message: apiMessage || err.message,
    });
    return res.status(err.response?.status || 500).json({
      error: apiMessage || 'Failed to retrieve selected items from Google Photos Picker',
    });
  }
});

const MAX_SIZE_IDS_PER_REQUEST = 10;

/**
 * POST /api/drive/picker/sizes
 * Body: { ids: [mediaItemId, ...] } (at most 10)
 * Looks up the byte size of picked Google Photos videos, using the download
 * URLs remembered from /picker/get-items. Returns { sizes: { [id]: bytes|null } }.
 * The frontend calls this in small batches so it can show progress.
 */
router.post('/picker/sizes', requireAuth, async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SIZE_IDS_PER_REQUEST
    || !ids.every((id) => typeof id === 'string' && id)) {
    return res.status(400).json({ error: `ids must be an array of 1-${MAX_SIZE_IDS_PER_REQUEST} media item IDs` });
  }

  try {
    const oAuth2Client = getAuthClient(req.session.tokens);
    const { token: accessToken } = await oAuth2Client.getAccessToken();
    const baseUrls = req.session.photoThumbnailUrls || {};

    const entries = await Promise.all(
      ids.map(async (id) => {
        const baseUrl = Object.prototype.hasOwnProperty.call(baseUrls, id) ? baseUrls[id] : null;
        return [id, await getVideoFileSize(baseUrl, accessToken)];
      })
    );
    return res.json({ sizes: Object.fromEntries(entries) });
  } catch (err) {
    console.error('Photos Picker sizes error:', err.message);
    return res.status(500).json({ error: 'Failed to read Google Photos video sizes' });
  }
});

module.exports = router;
module.exports.getDriveClient = getDriveClient;
module.exports.requireAuth = requireAuth;
