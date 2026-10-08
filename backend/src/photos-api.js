'use strict';

const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || `${BACKEND_URL}/auth/google/callback`;
const PHOTOS_API_BASE_URL = 'https://photoslibrary.googleapis.com/v1';
const PHOTOS_UPLOAD_URL = `${PHOTOS_API_BASE_URL}/uploads`;
const PHOTOS_MEDIA_ITEMS_URL = `${PHOTOS_API_BASE_URL}/mediaItems`;

function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

function getApiErrorMessage(err, fallbackMessage) {
  const photosMessage = err.response?.data?.error?.message;
  const genericMessage =
    typeof err.response?.data === 'string' ? err.response.data : err.response?.data?.error;
  return photosMessage || genericMessage || err.message || fallbackMessage;
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

function photosAlbumUrlKey(userId) {
  return `photos_album_url:${userId}`;
}

/**
 * The cached "open this album in Google Photos" URL for a user, or null when
 * unknown. Redis only — never calls Google, so it is safe on every poll.
 */
async function getCachedPhotosAlbumUrl(userId, redisClient) {
  if (!userId) return null;
  try {
    return (await redisClient.get(photosAlbumUrlKey(userId))) || null;
  } catch (err) {
    console.warn('[photos-api] failed to read cached photos album URL:', err.message);
    return null;
  }
}

async function cachePhotosAlbumUrl(userId, redisClient, productUrl) {
  if (!productUrl || typeof productUrl !== 'string') return;
  await redisClient.set(photosAlbumUrlKey(userId), productUrl);
}

/**
 * Albums created before the URL was being stored have no cached productUrl.
 * Fetch it once (best effort) so the UI can link to the album.
 */
async function backfillPhotosAlbumUrl(tokens, userId, redisClient, albumId) {
  if (await getCachedPhotosAlbumUrl(userId, redisClient)) return;
  try {
    const headers = await getPhotosRequestHeaders(tokens);
    const { data } = await axios.get(`${PHOTOS_API_BASE_URL}/albums/${encodeURIComponent(albumId)}`, { headers });
    await cachePhotosAlbumUrl(userId, redisClient, data?.productUrl);
  } catch (err) {
    console.warn(`[photos-api] could not fetch photos album URL for user ${userId}:`, err.message);
  }
}

async function getOrCreatePhotosAlbum(tokens, userId, redisClient) {
  const redisKey = `photos_album:${userId}`;
  const existingAlbumId = await redisClient.get(redisKey);
  if (existingAlbumId) {
    console.log(`[photos-api] found existing photos album ID in Redis for user ${userId}: ${existingAlbumId}`);
    await backfillPhotosAlbumUrl(tokens, userId, redisClient, existingAlbumId);
    return existingAlbumId;
  }

  console.log(`[photos-api] no existing photos album found in Redis for user ${userId}, creating one`);
  const accessToken = await getPhotosAccessToken(tokens);

  const response = await axios.post(
    `${PHOTOS_API_BASE_URL}/albums`,
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
  await cachePhotosAlbumUrl(userId, redisClient, response.data?.productUrl);
  console.log(`[photos-api] created new photos album ${albumId} and stored it in Redis for user ${userId}`);

  return albumId;
}

async function getPhotosRequestHeaders(tokens) {
  const accessToken = await getPhotosAccessToken(tokens);
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

async function getPhotoMediaItem(tokens, mediaItemId) {
  const headers = await getPhotosRequestHeaders(tokens);

  try {
    const { data } = await axios.get(`${PHOTOS_MEDIA_ITEMS_URL}/${encodeURIComponent(mediaItemId)}`, {
      headers,
    });
    return data;
  } catch (err) {
    throw new Error(getApiErrorMessage(err, `Failed to fetch Google Photos media item ${mediaItemId}`));
  }
}

function createAbortError() {
  const err = new Error('Download cancelled');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

async function downloadPhotoVideo(tokens, mediaItem, destPath, signal) {
  if (!mediaItem.baseUrl) {
    throw new Error(
      `Google Photos item "${mediaItem.filename || mediaItem.id}" is missing a download URL. The item may not be fully processed yet or may be inaccessible.`
    );
  }

  if (signal?.aborted) throw createAbortError();
  const headers = await getPhotosRequestHeaders(tokens);
  const response = await axios.get(`${mediaItem.baseUrl}=dv`, {
    headers,
    responseType: 'stream',
    signal,
  });

  return new Promise((resolve, reject) => {
    const dest = require('fs').createWriteStream(destPath);
    // An abort mid-body may not surface as a stream error, so tear down explicitly.
    const onAbort = () => {
      response.data.destroy();
      dest.destroy();
      reject(createAbortError());
    };
    const done = (fn) => (arg) => {
      signal?.removeEventListener('abort', onAbort);
      fn(arg);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    response.data
      .on('error', done(reject))
      .pipe(dest)
      .on('error', done(reject))
      .on('finish', done(resolve));
  });
}

async function uploadPhotoVideo(tokens, localPath, name, mimeType, description, albumId) {
  const headers = await getPhotosRequestHeaders(tokens);
  const uploadSize = require('fs').statSync(localPath).size;

  let uploadToken;
  try {
    const uploadResponse = await axios.post(PHOTOS_UPLOAD_URL, require('fs').createReadStream(localPath), {
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Content-Length': uploadSize,
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-Content-Type': mimeType,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      responseType: 'text',
      transformResponse: [(data) => data],
    });

    uploadToken = String(uploadResponse.data || '').trim();
  } catch (err) {
    throw new Error(getApiErrorMessage(err, 'Failed to upload optimised video bytes to Google Photos'));
  }

  if (!uploadToken) {
    throw new Error(
      'Google Photos upload did not return an upload token. This may indicate an API quota limit, authentication issue, or service unavailability.'
    );
  }

  try {
    const { data } = await axios.post(
      `${PHOTOS_MEDIA_ITEMS_URL}:batchCreate`,
      {
        albumId: albumId || null,
        newMediaItems: [
          {
            ...(description ? { description } : {}),
            simpleMediaItem: {
              uploadToken,
              fileName: name,
            },
          },
        ],
      },
      {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = data.newMediaItemResults?.[0];
    const statusCode = result?.status?.code || 0;
    if (!result || statusCode !== 0 || !result.mediaItem?.id) {
      throw new Error(result?.status?.message || 'Google Photos did not create the uploaded media item');
    }

    return result.mediaItem;
  } catch (err) {
    throw new Error(getApiErrorMessage(err, 'Failed to create Google Photos media item'));
  }
}

module.exports = {
  getOrCreatePhotosAlbum,
  getCachedPhotosAlbumUrl,
  getPhotosRequestHeaders,
  getPhotoMediaItem,
  downloadPhotoVideo,
  uploadPhotoVideo,
};
