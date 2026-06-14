'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { getDriveClient, requireAuth } = require('./drive');
const { createOAuthClient } = require('./auth');

const router = express.Router();

// In-memory job store (keyed by jobId)
const jobs = {};

const TARGET_HEIGHT = parseInt(process.env.TRANSCODE_HEIGHT || '720', 10);
const VIDEO_CRF = parseInt(process.env.TRANSCODE_CRF || '28', 10);
const VIDEO_PRESET = process.env.TRANSCODE_PRESET || 'medium';
const PHOTOS_API_BASE_URL = 'https://photoslibrary.googleapis.com/v1';
const PHOTOS_UPLOAD_URL = `${PHOTOS_API_BASE_URL}/uploads`;
const PHOTOS_MEDIA_ITEMS_URL = `${PHOTOS_API_BASE_URL}/mediaItems`;

/**
 * Download a Drive file to a temp path.
 */
async function downloadFile(drive, fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    response.data
      .on('error', reject)
      .pipe(dest)
      .on('error', reject)
      .on('finish', resolve);
  });
}

/**
 * Re-encode the video using ffmpeg.
 * Scales to TARGET_HEIGHT while preserving aspect ratio,
 * encodes with h264 at VIDEO_CRF quality.
 */
function transcodeVideo(inputPath, outputPath, metadata, onProgress) {
  const outputOptions = [
    '-map_metadata 0',
    `-vf scale=-2:${TARGET_HEIGHT}`,
    '-c:v libx264',
    `-crf ${VIDEO_CRF}`,
    `-preset ${VIDEO_PRESET}`,
    '-c:a aac',
    '-b:a 128k',
    '-movflags +faststart',
  ];

  if (metadata?.captureTimestamp) {
    outputOptions.push(`-metadata creation_time=${metadata.captureTimestamp}`);
  }

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('progress', (progress) => {
        if (typeof onProgress === 'function') {
          onProgress(progress.percent || 0);
        }
      })
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/**
 * Upload a file to Google Drive, inheriting the original file's parent folder.
 */
async function uploadFile(drive, localPath, name, mimeType, parents) {
  const { data } = await drive.files.create({
    requestBody: {
      name,
      mimeType,
      parents: parents && parents.length > 0 ? parents : undefined,
    },
    media: {
      mimeType,
      body: fs.createReadStream(localPath),
    },
    fields: 'id, name',
  });
  return data;
}

function getPhotosAuthClient(tokens) {
  const authClient = createOAuthClient();
  authClient.setCredentials(tokens);
  return authClient;
}

async function getPhotosRequestHeaders(tokens) {
  const authClient = getPhotosAuthClient(tokens);
  return authClient.getRequestHeaders();
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function getApiErrorMessage(err, fallbackMessage) {
  const photosMessage = err.response?.data?.error?.message;
  const genericMessage =
    typeof err.response?.data === 'string' ? err.response.data : err.response?.data?.error;
  return photosMessage || genericMessage || err.message || fallbackMessage;
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

async function downloadPhotoVideo(tokens, mediaItem, destPath) {
  if (!mediaItem.baseUrl) {
    throw new Error(
      `Google Photos item "${mediaItem.filename || mediaItem.id}" is missing a download URL. The item may not be fully processed yet or may be inaccessible.`
    );
  }

  const headers = await getPhotosRequestHeaders(tokens);
  const dest = fs.createWriteStream(destPath);
  const response = await axios.get(`${mediaItem.baseUrl}=dv`, {
    headers,
    responseType: 'stream',
  });

  return new Promise((resolve, reject) => {
    response.data
      .on('error', reject)
      .pipe(dest)
      .on('error', reject)
      .on('finish', resolve);
  });
}

async function uploadPhotoVideo(tokens, localPath, name, mimeType, description) {
  const headers = await getPhotosRequestHeaders(tokens);
  const uploadSize = getFileSize(localPath);

  let uploadToken;
  try {
    const uploadResponse = await axios.post(PHOTOS_UPLOAD_URL, fs.createReadStream(localPath), {
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Content-Length': uploadSize,
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-Content-Type': mimeType,
      },
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

/**
 * POST /api/optimise/start
 * Body: { fileIds: [string] }
 *
 * Queues optimisation jobs for the supplied file IDs and returns the job IDs.
 */
router.post('/start', requireAuth, async (req, res) => {
  const legacyFileIds = req.body?.fileIds;
  const items = Array.isArray(req.body?.items)
    ? req.body.items
    : Array.isArray(legacyFileIds)
      ? legacyFileIds.map((fileId) => ({ id: fileId, source: 'drive' }))
      : null;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  if (items.some((item) => !item?.id || (item.source && !['drive', 'photos'].includes(item.source)))) {
    return res.status(400).json({ error: 'each item must include an id; source, when provided, must be drive or photos' });
  }

  const jobIds = items.map(({ id: fileId, source = 'drive' }) => {
    const jobId = uuidv4();
    jobs[jobId] = { jobId, fileId, source, status: 'queued', progress: 0, error: null };
    return { jobId, fileId, source };
  });

  // Snapshot session tokens once so the async workers have a copy
  const tokens = req.session.tokens;

  // Process jobs asynchronously
  jobIds.forEach(({ jobId, fileId, source }) => {
    processJob(jobId, { fileId, source }, tokens).catch((err) => {
      console.error(`Job ${jobId} failed:`, err.message);
    });
  });

  return res.json({ jobs: jobIds });
});

/**
 * GET /api/optimise/status/:jobId
 * Returns the current status of an optimisation job.
 */
router.get('/status/:jobId', requireAuth, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

/**
 * GET /api/optimise/status
 * Returns the current status of all jobs in this server process.
 */
router.get('/status', requireAuth, (_req, res) => {
  return res.json({ jobs: Object.values(jobs) });
});

/**
 * Core async processing pipeline for a single file optimisation job.
 */
async function processJob(jobId, item, tokens) {
  const job = jobs[jobId];
  const { fileId, source } = item;
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `cdo_input_${jobId}`);
  const outputPath = path.join(tmpDir, `cdo_output_${jobId}.mp4`);

  try {
    if (source === 'photos') {
      await processPhotosJob(job, tokens, fileId, inputPath, outputPath);
    } else {
      await processDriveJob(job, tokens, fileId, inputPath, outputPath);
    }
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    throw err;
  } finally {
    // Clean up temp files
    for (const p of [inputPath, outputPath]) {
      try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
    }
  }
}

async function processDriveJob(job, tokens, fileId, inputPath, outputPath) {
  const drive = getDriveClient(tokens);

  job.status = 'fetching_metadata';
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, parents, size, quotaBytesUsed, createdTime',
  });

  job.fileName = meta.name;
  job.originalFileName = meta.name;
  job.captureTimestamp = meta.createdTime || null;

  if (!meta.mimeType || !meta.mimeType.startsWith('video/')) {
    throw new Error(`File "${meta.name}" is not a video (mimeType: ${meta.mimeType})`);
  }

  job.status = 'downloading';
  job.progress = 0;
  await downloadFile(drive, fileId, inputPath);
  job.originalSize = getFileSize(inputPath) || parseInt(meta.size || meta.quotaBytesUsed || '0', 10);

  job.status = 'transcoding';
  job.progress = 0;
  await transcodeVideo(inputPath, outputPath, { captureTimestamp: job.captureTimestamp }, (pct) => {
    job.progress = Math.round(pct);
  });
  job.progress = 100;
  job.newSize = getFileSize(outputPath);

  job.status = 'uploading';
  const optimisedName = buildOptimisedName(meta.name, TARGET_HEIGHT);
  const uploaded = await uploadFile(drive, outputPath, optimisedName, 'video/mp4', meta.parents);

  job.status = 'deleting_original';
  await drive.files.delete({ fileId });

  job.status = 'complete';
  job.newFileId = uploaded.id;
  job.newFileName = uploaded.name;
  job.uploadedTo = 'drive';
  job.manualCleanupRequired = false;
}

async function processPhotosJob(job, tokens, fileId, inputPath, outputPath) {
  job.status = 'fetching_metadata';
  const mediaItem = await getPhotoMediaItem(tokens, fileId);

  job.fileName = mediaItem.filename || mediaItem.id;
  job.originalFileName = mediaItem.filename || mediaItem.id;
  job.captureTimestamp = mediaItem.mediaMetadata?.creationTime || null;

  if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith('video/')) {
    throw new Error(`File "${job.fileName}" is not a video (mimeType: ${mediaItem.mimeType})`);
  }

  job.status = 'downloading';
  job.progress = 0;
  await downloadPhotoVideo(tokens, mediaItem, inputPath);
  job.originalSize = getFileSize(inputPath);

  job.status = 'transcoding';
  job.progress = 0;
  await transcodeVideo(inputPath, outputPath, { captureTimestamp: job.captureTimestamp }, (pct) => {
    job.progress = Math.round(pct);
  });
  job.progress = 100;
  job.newSize = getFileSize(outputPath);

  job.status = 'uploading';
  const optimisedName = buildOptimisedName(job.originalFileName, TARGET_HEIGHT);
  const uploaded = await uploadPhotoVideo(
    tokens,
    outputPath,
    optimisedName,
    'video/mp4',
    mediaItem.description || undefined
  );

  job.status = 'complete';
  job.newFileId = uploaded.id;
  job.newFileName = uploaded.filename || optimisedName;
  job.uploadedTo = 'photos';
  job.manualCleanupRequired = true;
}

/**
 * Derive a new filename for the re-encoded video.
 * e.g. "holiday.mov" → "holiday_720p.mp4"
 */
function buildOptimisedName(originalName, height) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  return `${base}_${height}p.mp4`;
}

module.exports = router;
module.exports.buildOptimisedName = buildOptimisedName;
