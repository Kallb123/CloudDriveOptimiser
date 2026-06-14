'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { getDriveClient, requireAuth } = require('./drive');

const router = express.Router();

// In-memory job store (keyed by jobId)
const jobs = {};

const TARGET_HEIGHT = parseInt(process.env.TRANSCODE_HEIGHT || '720', 10);
const VIDEO_CRF = parseInt(process.env.TRANSCODE_CRF || '28', 10);
const VIDEO_PRESET = process.env.TRANSCODE_PRESET || 'medium';

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
function transcodeVideo(inputPath, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        `-vf scale=-2:${TARGET_HEIGHT}`,
        '-c:v libx264',
        `-crf ${VIDEO_CRF}`,
        `-preset ${VIDEO_PRESET}`,
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
      ])
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

/**
 * POST /api/optimise/start
 * Body: { fileIds: [string] }
 *
 * Queues optimisation jobs for the supplied file IDs and returns the job IDs.
 */
router.post('/start', requireAuth, async (req, res) => {
  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'fileIds must be a non-empty array' });
  }

  const jobIds = fileIds.map((fileId) => {
    const jobId = uuidv4();
    jobs[jobId] = { jobId, fileId, status: 'queued', progress: 0, error: null };
    return { jobId, fileId };
  });

  // Snapshot session tokens once so the async workers have a copy
  const tokens = req.session.tokens;

  // Process jobs asynchronously
  jobIds.forEach(({ jobId, fileId }) => {
    processJob(jobId, fileId, tokens).catch((err) => {
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
async function processJob(jobId, fileId, tokens) {
  const job = jobs[jobId];
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `cdo_input_${jobId}`);
  const outputPath = path.join(tmpDir, `cdo_output_${jobId}.mp4`);

  try {
    const drive = getDriveClient(tokens);

    // --- Step 1: fetch file metadata ---
    job.status = 'fetching_metadata';
    const { data: meta } = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, parents',
    });

    job.fileName = meta.name;

    if (!meta.mimeType || !meta.mimeType.startsWith('video/')) {
      throw new Error(`File "${meta.name}" is not a video (mimeType: ${meta.mimeType})`);
    }

    // --- Step 2: download ---
    job.status = 'downloading';
    job.progress = 0;
    await downloadFile(drive, fileId, inputPath);

    // --- Step 3: transcode ---
    job.status = 'transcoding';
    job.progress = 0;
    await transcodeVideo(inputPath, outputPath, (pct) => {
      job.progress = Math.round(pct);
    });
    job.progress = 100;

    // --- Step 4: upload optimised file ---
    job.status = 'uploading';
    const optimisedName = buildOptimisedName(meta.name, TARGET_HEIGHT);
    const uploaded = await uploadFile(
      drive,
      outputPath,
      optimisedName,
      'video/mp4',
      meta.parents
    );

    // --- Step 5: delete original ---
    job.status = 'deleting_original';
    await drive.files.delete({ fileId });

    job.status = 'complete';
    job.newFileId = uploaded.id;
    job.newFileName = uploaded.name;
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
