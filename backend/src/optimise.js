'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const { ZipArchive } = require('archiver');
const { exiftool } = require('exiftool-vendored');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { getDriveClient, requireAuth } = require('./drive');
const {
  getPhotoMediaItem,
  downloadPhotoVideo,
  uploadPhotoVideo,
  getCachedPhotosAlbumUrl,
} = require('./photos-api');
const redisClient = require('./redis-client');
const jobStore = require('./job-store');
const { createJobQueue } = require('./job-queue');

const router = express.Router();
const jobs = {};

const TARGET_HEIGHT = parseInt(process.env.TRANSCODE_HEIGHT || '720', 10);
const VIDEO_CRF = parseInt(process.env.TRANSCODE_CRF || '28', 10);
// VIDEO_PRESET is the legacy name, kept as a fallback for existing deployments.
const VIDEO_PRESET = process.env.TRANSCODE_PRESET || process.env.VIDEO_PRESET || 'medium';
const MAX_CONCURRENT_JOBS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10) || 1);
const MIN_SAVING_PERCENT = parseFloat(process.env.MIN_SAVING_PERCENT || '10');
const LOG_PREFIX = '[optimise]';

// Choices offered to the user in the "Review & confirm" dialog. The configured
// default height is always selectable, even if it is not one of the presets.
const RESOLUTION_OPTIONS = [480, 720, 1080];
const QUALITY_OPTIONS = [
  { key: 'smaller', label: 'Smaller file', crf: 30 },
  { key: 'balanced', label: 'Balanced', crf: 28 },
  { key: 'quality', label: 'Higher quality', crf: 23 },
];
const MIN_CRF = 18;
const MAX_CRF = 35;

function getResolutionOptions() {
  return [...new Set([...RESOLUTION_OPTIONS, TARGET_HEIGHT])]
    .filter((h) => Number.isInteger(h) && h > 0)
    .sort((a, b) => a - b);
}

/**
 * Validate the optional per-batch `options` from POST /start.
 * Returns { options: { targetHeight, crf } } with server defaults filled in for
 * missing fields, or { error } when a supplied value is invalid.
 * Numeric strings (e.g. '720') are accepted via Number() coercion, then held to
 * the same rules as numbers; everything else is rejected.
 */
function parseJobOptions(rawOptions) {
  if (rawOptions === undefined || rawOptions === null) {
    return { options: { targetHeight: TARGET_HEIGHT, crf: VIDEO_CRF } };
  }
  if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return { error: 'options must be an object' };
  }

  const toNumber = (value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
  };
  const isMissing = (value) => value === undefined || value === null;

  let targetHeight = TARGET_HEIGHT;
  if (!isMissing(rawOptions.targetHeight)) {
    targetHeight = toNumber(rawOptions.targetHeight);
    if (!getResolutionOptions().includes(targetHeight)) {
      return { error: `options.targetHeight must be one of: ${getResolutionOptions().join(', ')}` };
    }
  }

  let crf = VIDEO_CRF;
  if (!isMissing(rawOptions.crf)) {
    crf = toNumber(rawOptions.crf);
    if (!Number.isInteger(crf) || crf < MIN_CRF || crf > MAX_CRF) {
      return { error: `options.crf must be an integer between ${MIN_CRF} and ${MAX_CRF}` };
    }
  }

  return { options: { targetHeight, crf } };
}

// Statuses a user may cancel. Not 'uploading' / 'trashing_original': stopping
// those mid-flight risks duplicate uploads or a half-replaced original.
const CANCELLABLE_STATUSES = new Set(['queued', 'fetching_metadata', 'downloading', 'transcoding']);
const RETRYABLE_STATUSES = new Set(['error', 'cancelled']);

class JobCancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'JobCancelledError';
    this.cancelled = true;
  }
}

// One AbortController per job that has started (or is about to start)
// processing. Created in processJob / by the cancel endpoint, removed in
// processJob's finally. Also doubles as "this job's pipeline is still winding
// down" so retry can refuse to race it.
const jobControllers = new Map();

function getJobController(jobId) {
  let controller = jobControllers.get(jobId);
  if (!controller) {
    controller = new AbortController();
    jobControllers.set(jobId, controller);
  }
  return controller;
}

function isJobCancelled(job) {
  return Boolean(job?.cancelRequested) || Boolean(jobControllers.get(job?.jobId)?.signal.aborted);
}

/** Call between pipeline steps; never start an upload without it. */
function throwIfCancelled(job) {
  if (isJobCancelled(job)) throw new JobCancelledError();
}

const photosUploadMutex = {
  current: Promise.resolve(),
};

async function enqueuePhotosUpload(task) {
  const next = photosUploadMutex.current.then(() => task());
  // Keep the chain alive even if a task fails so subsequent uploads still run.
  photosUploadMutex.current = next.catch(() => {});
  return next;
}

// FIFO queue of jobs waiting for a free slot. Jobs stay 'queued' until started.
const jobQueue = createJobQueue({
  limit: MAX_CONCURRENT_JOBS,
  run: ({ jobId, item, tokens }) => processJob(jobId, item, tokens),
  onError: (err, { jobId }) => {
    console.error(`${LOG_PREFIX} Job ${jobId} failed:`, err.message);
  },
});

function removeTempFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`${LOG_PREFIX} failed to remove temp file`, { path: filePath, error: err.message });
    }
  }
}

/**
 * Run once at startup, before requests are accepted: any job still in a
 * non-terminal state was interrupted by a restart, so mark it as failed and
 * remove its temp files. Never throws.
 */
async function recoverInterruptedJobs() {
  try {
    const recovered = await jobStore.recoverInterruptedJobs();
    for (const { jobId } of recovered) {
      removeTempFile(path.join(os.tmpdir(), `cdo_input_${jobId}`));
      removeTempFile(path.join(os.tmpdir(), `cdo_output_${jobId}.mov`));
    }
    console.log(`${LOG_PREFIX} recovered ${recovered.length} job(s) interrupted by a restart`);
    return recovered;
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to recover interrupted jobs:`, err.message);
    return [];
  }
}

function sanitizeJob(job) {
  if (!job) return null;
  const { tempOutputPath, ...sanitized } = job;
  return sanitized;
}

async function loadSessionJobById(sessionId, jobId) {
  const job = await jobStore.loadJob(jobId);
  if (!job || job.sessionId !== sessionId) return null;
  return job;
}

/**
 * Download a Drive file to a temp path.
 */
async function downloadFile(drive, fileId, destPath, signal) {
  console.log(`${LOG_PREFIX} downloading Drive file ${fileId} to ${destPath}`);
  if (signal?.aborted) throw new JobCancelledError();
  const dest = fs.createWriteStream(destPath);
  let response;
  try {
    response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream', signal }
    );
  } catch (err) {
    dest.destroy();
    throw err;
  }
  return new Promise((resolve, reject) => {
    // An abort mid-body may not surface as a stream error, so tear down explicitly.
    const onAbort = () => {
      response.data.destroy();
      dest.destroy();
      reject(new JobCancelledError());
    };
    const settle = (fn) => (arg) => {
      signal?.removeEventListener('abort', onAbort);
      fn(arg);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    response.data
      .on('error', settle((err) => {
        console.error(`${LOG_PREFIX} download error for file ${fileId}:`, err.message);
        reject(err);
      }))
      .pipe(dest)
      .on('error', settle((err) => {
        console.error(`${LOG_PREFIX} write error for ${destPath}:`, err.message);
        reject(err);
      }))
      .on('finish', settle(() => {
        console.log(`${LOG_PREFIX} completed download of Drive file ${fileId}`);
        resolve();
      }));
  });
}

function getOriginalCreationTime(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      
      // Look for creation_time in format tags or stream tags
      const creationTime = metadata.format.tags?.creation_time 
                        || metadata.streams[0]?.tags?.creation_time;
                        
      resolve(creationTime || null); 
    });
  });
}

/**
 * Re-encode the video using ffmpeg.
 * Scales to targetHeight while preserving aspect ratio (never upscaling),
 * encodes with h264 at the given CRF.
 */
async function transcodeVideo(inputPath, outputPath, metadata, shouldUseWidth, onProgress, targetHeight = TARGET_HEIGHT, crf = VIDEO_CRF, signal) {
  console.log(`${LOG_PREFIX} transcoding video ${inputPath} to ${outputPath} with target height ${targetHeight}, crf ${crf} ${shouldUseWidth}`);
  // Only ever downscale: min() caps the target at the source dimension, and
  // trunc(.../2)*2 keeps the result even for libx264. The single quotes stop the
  // commas inside min() being parsed as filter separators.
  const scaleArg = shouldUseWidth
    ? `'trunc(min(${targetHeight},iw)/2)*2':-2`
    : `-2:'trunc(min(${targetHeight},ih)/2)*2'`;
  if (signal?.aborted) throw new JobCancelledError();
  const originalDate = await getOriginalCreationTime(inputPath);
  if (signal?.aborted) throw new JobCancelledError();
  const outputOptions = [
    '-map_metadata 0',
    `-vf scale=${scaleArg}`,
    '-c:v libx264',
    `-crf ${crf}`,
    `-preset ${VIDEO_PRESET}`,
    '-c:a aac',
    '-b:a 128k',
    '-f mov',
    // Force the output container to recognize custom metadata tags
    '-movflags use_metadata_tags'
  ];

  console.log(`${LOG_PREFIX} attempting to preserve metadata:`, JSON.stringify(metadata, null, 2));

  await new Promise((resolve, reject) => {
    const command =
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outputPath);

    // If an original creation time was found, inject it explicitly
    if (originalDate) {
      command.outputOptions(`-metadata creation_time=${originalDate}`);
    } else if (metadata.captureTimestamp) {
      command.outputOptions(`-metadata creation_time=${metadata.captureTimestamp}`);
    }
  
    // Killing the process makes fluent-ffmpeg emit 'error', which rejects below.
    const killFfmpeg = () => {
      try {
        command.kill('SIGKILL');
      } catch (err) {
        console.warn(`${LOG_PREFIX} failed to kill ffmpeg`, { error: err.message });
      }
    };
    const onAbort = () => killFfmpeg();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    command
      .on('start', () => {
        // fluent-ffmpeg only has a process to kill once it has spawned, so an
        // abort that landed before this point is honoured here instead.
        if (signal?.aborted) killFfmpeg();
      })
      .on('progress', (progress) => {
        if (typeof onProgress === 'function') {
          onProgress(progress.percent || 0);
        }
      })
      .on('end', () => {
        cleanup();
        resolve();
      })
      .on('error', (err) => {
        cleanup();
        reject(signal?.aborted ? new JobCancelledError() : err);
      });

    if (signal) {
      if (signal.aborted) {
        reject(new JobCancelledError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    command.run();
  });
  if (signal?.aborted) throw new JobCancelledError();

  console.log(`${LOG_PREFIX} Cloning base metadata...`);

  // STEP 1: Copy everything from the source file first
  await exiftool.write(outputPath, {}, [
    '-overwrite_original',
    '-tagsFromFile', inputPath,
    '-All:All'
  ]);
  
  // STEP 2: Apply explicit overrides with the UTC API flag enabled
  const exifTags = { 
    SourceFile: inputPath,
    Rotation: 0 
  };
  if (metadata.captureTimestamp) {
    exifTags.CreateDate = metadata.captureTimestamp;
    exifTags.ModifyDate = metadata.captureTimestamp;
    exifTags.TrackCreateDate = metadata.captureTimestamp;
    exifTags.MediaCreateDate = metadata.captureTimestamp;
    exifTags.DateTimeOriginal = metadata.captureTimestamp;
    exifTags['Keys:CreationDate'] = metadata.captureTimestamp,
    exifTags['QuickTime:CreateDate'] = metadata.captureTimestamp,
    exifTags['QuickTime:ModifyDate'] = metadata.captureTimestamp,
    exifTags['QuickTime:TrackCreateDate'] = metadata.captureTimestamp,
    exifTags['QuickTime:MediaCreateDate'] = metadata.captureTimestamp
  }

  if (metadata.location?.latitude != null && metadata.location?.longitude != null) {
    const lat = Number(metadata.location.latitude);
    const lng = Number(metadata.location.longitude);

    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      exifTags.GPSLatitude = lat;
      exifTags.GPSLongitude = lng;
      exifTags.GPSLatitudeRef = lat >= 0 ? 'N' : 'S';
      exifTags.GPSLongitudeRef = lng >= 0 ? 'E' : 'W';
      if (metadata.location.altitude != null) {
        const alt = Number(metadata.location.altitude);
        if (!Number.isNaN(alt)) {
          exifTags.GPSAltitude = alt;
          exifTags.GPSAltitudeRef = alt >= 0 ? 'Above Sea Level' : 'Below Sea Level';
        }
      }
    }
  }
  
  console.log(`${LOG_PREFIX} Injecting metadata into output file:`, JSON.stringify(exifTags, null, 2));

  await exiftool.write(outputPath, exifTags, [
    '-overwrite_original',
    '-api', 'QuickTimeUTC=1' // CRUCIAL: Forces valid UTC encoding for Google Photos
  ]);

  if (metadata.captureTimestamp) {
    try {
      const ts = new Date(metadata.captureTimestamp);
      if (!Number.isNaN(ts.getTime())) {
        await fs.promises.utimes(outputPath, ts, ts);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} failed to set output file timestamp`, { path: outputPath, error: err.message });
    }
  }

  console.log(`${LOG_PREFIX} Metadata injection successful!`);
}

/**
 * Upload a file to Google Drive, inheriting the original file's parent folder.
 */
async function uploadFile(drive, localPath, name, mimeType, parents) {
  console.log(`${LOG_PREFIX} uploading ${localPath} to Drive as ${name}`);
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
  console.log(`${LOG_PREFIX} uploaded file to Drive: ${data.id}`);
  return data;
}


function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function parseVideoDimension(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isPortraitFromVideoMetadata(metadata) {
  const width = parseVideoDimension(metadata?.width || metadata?.videoMediaMetadata?.width);
  const height = parseVideoDimension(metadata?.height || metadata?.videoMediaMetadata?.height);

  if (width > 0 && height > 0) {
    const rotation = parseVideoDimension(metadata?.rotation || metadata?.rotate || metadata?.videoMediaMetadata?.rotation);
    if (rotation === 90 || rotation === 270) {
      return width > height;
    }
    return height > width;
  }

  return null;
}

function getVideoOrientation(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        return reject(err);
      }

      const stream = metadata.streams?.find((s) => s.codec_type === 'video');
      if (!stream) {
        return reject(new Error('No video stream found for orientation detection'));
      }

      let width = stream.width;
      let height = stream.height;
      const rotation = parseInt(stream.tags?.rotate || '0', 10) || 0;

      if (rotation === 90 || rotation === 270) {
        [width, height] = [height, width];
      }

      resolve({
        width,
        height,
        rotation,
        isPortrait: height > width,
      });
    });
  });
}

async function determinePortraitOrientation(inputPath, metadata) {
  const metadataPortrait = isPortraitFromVideoMetadata(metadata);
  if (metadataPortrait !== null) {
    return metadataPortrait;
  }

  const orientation = await getVideoOrientation(inputPath);
  return orientation.isPortrait;
}

function getApiErrorMessage(err, fallbackMessage) {
  const photosMessage = err.response?.data?.error?.message;
  const genericMessage =
    typeof err.response?.data === 'string' ? err.response.data : err.response?.data?.error;
  return photosMessage || genericMessage || err.message || fallbackMessage;
}

/**
 * POST /api/optimise/start
 * Body: { items: [...], options?: { targetHeight, crf } }
 * (legacy: { fileIds: [string] })
 *
 * Queues optimisation jobs for the supplied file IDs and returns the job IDs.
 */
router.post('/start', requireAuth, async (req, res) => {
  console.log(`${LOG_PREFIX} optimisation request received`, {
    sessionId: req.sessionID,
    userId: req.session?.user?.id,
    body: req.body,
  });

  const legacyFileIds = req.body?.fileIds;
  const items = Array.isArray(req.body?.items)
    ? req.body.items
    : Array.isArray(legacyFileIds)
      ? legacyFileIds.map((fileId) => ({ id: fileId, source: 'drive' }))
      : null;

  if (!Array.isArray(items) || items.length === 0) {
    console.warn(`${LOG_PREFIX} invalid optimisation request: missing or empty items`, {
      sessionId: req.sessionID,
      body: req.body,
    });
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  const parsedOptions = parseJobOptions(req.body?.options);
  if (parsedOptions.error) {
    console.warn(`${LOG_PREFIX} invalid optimisation options`, {
      sessionId: req.sessionID,
      options: req.body?.options,
      error: parsedOptions.error,
    });
    return res.status(400).json({ error: parsedOptions.error });
  }
  const { targetHeight, crf } = parsedOptions.options;

  const albumId = req.session.photosAlbumId || null;
  if (!albumId) {
    console.warn(`${LOG_PREFIX} missing photos album ID in session`, {
      sessionId: req.sessionID,
      userId: req.session?.user?.id,
    });
  }

  if (items.some((item) => {
    const hasId = Boolean(item?.id || item?.mediaItem?.id);
    return !hasId || (item.source && !['drive', 'photos'].includes(item.source));
  })) {
    console.warn(`${LOG_PREFIX} invalid optimisation item`, { sessionId: req.sessionID, items });
    return res.status(400).json({ error: 'each item must include an id or mediaItem; source, when provided, must be drive or photos' });
  }

  const queuedJobs = [];
  for (const item of items) {
    const jobId = uuidv4();
    const fileId = item.id || item.mediaItem?.id;
    const source = item.source || 'drive';
    const upload = item.upload !== false;
    const job = {
      jobId,
      sessionId: req.sessionID,
      fileId,
      albumId,
      item,
      source,
      upload,
      targetHeight,
      crf,
      status: 'queued',
      progress: 0,
      error: null,
      cancelRequested: false,
      originalRemovedByUser: false,
      newProductUrl: null,
      interruptedStage: null,
      retryCount: 0,
    };

    jobs[jobId] = job;
    await jobStore.saveJobWithSession(job);
    queuedJobs.push({ jobId, fileId, source, item, upload, targetHeight, crf });
  }

  const tokens = req.session.tokens;

  // Jobs run in the background, at most MAX_CONCURRENT_JOBS at a time
  queuedJobs.forEach(({ jobId, fileId, source }) => {
    console.log(`${LOG_PREFIX} queued optimisation job`, { jobId, fileId, source });
  });
  jobQueue.enqueue(...queuedJobs.map(({ jobId, item }) => ({
    jobId,
    sessionId: req.sessionID,
    item,
    tokens,
  })));

  return res.json({
    jobs: queuedJobs.map(({ jobId, fileId, source, upload, targetHeight, crf }) => ({
      jobId, fileId, source, upload, targetHeight, crf,
    })),
  });
});

/**
 * GET /api/optimise/config
 * Server defaults and the choices offered in the Review & confirm dialog.
 */
router.get('/config', requireAuth, (req, res) => {
  return res.json({
    targetHeight: TARGET_HEIGHT,
    crf: VIDEO_CRF,
    preset: VIDEO_PRESET,
    minSavingPercent: MIN_SAVING_PERCENT,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    resolutionOptions: getResolutionOptions(),
    qualityOptions: QUALITY_OPTIONS,
  });
});

/**
 * POST /api/optimise/clear
 * Clears the stored optimisation job list for the authenticated session.
 */
router.post('/clear', requireAuth, async (req, res) => {
  console.log(`${LOG_PREFIX} clear requested for session jobs`, {
    sessionId: req.sessionID,
    userId: req.session?.user?.id,
  });
  // Drop this session's not-yet-started jobs so they don't run invisibly after
  // the history is cleared. Running jobs are left alone.
  const cancelled = jobQueue.removePending((entry) => entry.sessionId === req.sessionID);
  for (const { jobId } of cancelled) {
    const job = jobs[jobId];
    delete jobs[jobId];
    if (job) {
      // Persist a terminal state so the job leaves the active set.
      job.status = 'cancelled';
      job.error = null;
      job.progress = 0;
      await jobStore.saveJob(job).catch((err) => {
        console.error(`${LOG_PREFIX} failed to persist cancelled job`, { jobId, error: err.message });
      });
    }
  }
  if (cancelled.length > 0) {
    console.log(`${LOG_PREFIX} removed ${cancelled.length} queued job(s) from the pending queue`, { sessionId: req.sessionID });
  }

  const sessionJobs = await jobStore.loadSessionJobs(req.sessionID);
  for (const job of sessionJobs) {
    if (job?.tempOutputPath) {
      try {
        fs.unlinkSync(job.tempOutputPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`${LOG_PREFIX} failed to remove temp output file during clear`, { path: job.tempOutputPath, error: err.message });
        }
      }
    }
  }
  await jobStore.clearSessionJobs(req.sessionID);
  return res.json({ success: true });
});

/**
 * GET /api/optimise/status/:jobId
 * Returns the current status of an optimisation job.
 */
router.get('/status/:jobId', requireAuth, async (req, res) => {
  console.log(`${LOG_PREFIX} status requested for job`, {
    sessionId: req.sessionID,
    jobId: req.params.jobId,
  });
  let job = await loadSessionJobById(req.sessionID, req.params.jobId);
  if (!job) {
    const memoryJob = jobs[req.params.jobId];
    if (memoryJob && memoryJob.sessionId === req.sessionID) {
      job = memoryJob;
    }
  }
  if (!job) {
    console.warn(`${LOG_PREFIX} status request failed - job not found`, {
      sessionId: req.sessionID,
      jobId: req.params.jobId,
    });
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(sanitizeJob(job));
});

/**
 * GET /api/optimise/status
 * Returns the current status of all jobs for the authenticated session.
 */
router.get('/status', requireAuth, async (req, res) => {
  console.log(`${LOG_PREFIX} status requested for session jobs`, {
    sessionId: req.sessionID,
  });
  const sessionJobs = await jobStore.loadSessionJobs(req.sessionID);
  // Cached values only (session, then redis) — never a Google API call per poll.
  const photosAlbumUrl = req.session?.photosAlbumUrl
    || await getCachedPhotosAlbumUrl(req.session?.user?.id, redisClient)
    || null;
  return res.json({ jobs: sessionJobs.map(sanitizeJob), photosAlbumUrl });
});

/**
 * POST /api/optimise/jobs/:jobId/cancel
 * Cancels a queued or in-progress (pre-upload) job.
 */
router.post('/jobs/:jobId/cancel', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const loaded = await loadSessionJobById(req.sessionID, jobId);
  if (!loaded) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // The in-memory job is what a running pipeline mutates, so it is authoritative
  // for status. Everything from here to abort() is synchronous on purpose: the
  // pipeline can only move to 'uploading' between awaits, so a status checked
  // here cannot change before the abort takes effect.
  const live = jobs[jobId] && jobs[jobId].sessionId === req.sessionID ? jobs[jobId] : loaded;
  if (!CANCELLABLE_STATUSES.has(live.status)) {
    return res.status(409).json({ error: `Job cannot be cancelled while ${live.status}` });
  }

  const removed = jobQueue.removePending((entry) => entry.jobId === jobId);
  if (removed.length > 0 || !jobs[jobId]) {
    // Never started (or no process owns it): finish it here.
    delete jobs[jobId];
    live.status = 'cancelled';
    live.error = null;
    live.progress = 0;
    live.cancelRequested = false;
    await jobStore.saveJob(live);
    console.log(`${LOG_PREFIX} cancelled queued job`, { jobId });
    return res.json({ job: sanitizeJob(live) });
  }

  // Running (or about to start): flag it and stop the work. processJob's catch
  // records the 'cancelled' status once the pipeline has actually stopped.
  live.cancelRequested = true;
  getJobController(jobId).abort();
  console.log(`${LOG_PREFIX} cancellation requested for running job`, { jobId, status: live.status });
  await jobStore.saveJob(live).catch((err) => {
    console.error(`${LOG_PREFIX} failed to persist cancel request`, { jobId, error: err.message });
  });
  return res.json({ job: sanitizeJob(live) });
});

/**
 * POST /api/optimise/jobs/:jobId/retry
 * Re-queues a failed or cancelled job (same jobId).
 */
router.post('/jobs/:jobId/retry', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const job = await loadSessionJobById(req.sessionID, jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (!RETRYABLE_STATUSES.has(job.status)) {
    return res.status(409).json({ error: `Job cannot be retried while ${job.status}` });
  }
  // The previous run may still be cleaning up its temp files (same paths).
  if (jobControllers.has(jobId)) {
    return res.status(409).json({ error: 'Job is still stopping — try again in a moment' });
  }

  job.status = 'queued';
  job.progress = 0;
  job.error = null;
  job.skipReason = null;
  job.newSize = null;
  job.newFileId = null;
  job.newFileName = null;
  job.newProductUrl = null;
  job.originalTrashed = false;
  job.interruptedStage = null;
  job.downloadAvailable = false;
  job.manualCleanupRequired = false;
  job.originalRemovedByUser = false;
  job.cancelRequested = false;
  job.retryCount = (Number.isInteger(job.retryCount) ? job.retryCount : 0) + 1;
  delete job.tempOutputPath;
  delete job.uploadedTo;
  if (req.session.photosAlbumId) job.albumId = req.session.photosAlbumId;

  // processJob reads jobs[jobId]; after a restart the map is empty.
  jobs[jobId] = job;
  await jobStore.saveJob(job);
  jobQueue.enqueue({ jobId, sessionId: req.sessionID, item: job.item, tokens: req.session.tokens });
  console.log(`${LOG_PREFIX} retrying job`, { jobId, retryCount: job.retryCount });
  return res.json({ job: sanitizeJob(job) });
});

/**
 * POST /api/optimise/jobs/:jobId/cleanup
 * Body: { removed: boolean }
 * Records whether the user has deleted the original from Google Photos.
 */
router.post('/jobs/:jobId/cleanup', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  if (typeof req.body?.removed !== 'boolean') {
    return res.status(400).json({ error: 'removed must be a boolean' });
  }
  const job = await loadSessionJobById(req.sessionID, jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  if (job.status !== 'complete' || !job.manualCleanupRequired) {
    return res.status(409).json({ error: 'This job does not need manual cleanup' });
  }
  job.originalRemovedByUser = req.body.removed;
  if (jobs[jobId]) jobs[jobId].originalRemovedByUser = job.originalRemovedByUser;
  await jobStore.saveJob(job);
  return res.json({ job: sanitizeJob(job) });
});

router.get('/download/:jobId', requireAuth, async (req, res) => {
  console.log(`${LOG_PREFIX} download requested for job`, {
    sessionId: req.sessionID,
    jobId: req.params.jobId,
  });

  const job = await loadSessionJobById(req.sessionID, req.params.jobId);
  if (!job || job.status !== 'complete' || !job.tempOutputPath) {
    return res.status(404).json({ error: 'Download not available' });
  }

  if (!fs.existsSync(job.tempOutputPath)) {
    return res.status(404).json({ error: 'Optimised file not found' });
  }

  return res.download(job.tempOutputPath, job.newFileName || path.basename(job.tempOutputPath), (err) => {
    if (err) {
      console.error(`${LOG_PREFIX} download failed`, { jobId: req.params.jobId, error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    }
  });
});

router.get('/download-all', requireAuth, async (req, res) => {
  console.log(`${LOG_PREFIX} download-all requested`, {
    sessionId: req.sessionID,
  });

  const sessionJobs = await jobStore.loadSessionJobs(req.sessionID);
  const readyJobs = sessionJobs.filter(
    (job) => job.status === 'complete' && job.tempOutputPath && fs.existsSync(job.tempOutputPath)
  );

  if (readyJobs.length === 0) {
    return res.status(404).json({ error: 'No completed downloads available' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="cdo-optimised-videos.zip"');
  const archive = new ZipArchive({
    zlib: { level: 9 }, // Sets the compression level.
  });
  archive.on('error', (err) => {
    console.error(`${LOG_PREFIX} download-all archive error`, { error: err.message });
    if (!res.headersSent) {
      res.status(500).end();
    }
  });
  archive.pipe(res);
  readyJobs.forEach((job) => {
    archive.file(job.tempOutputPath, {
      name: job.newFileName || `${job.jobId}.mov`,
    });
  });
  await archive.finalize();
});

/**
 * True only when the optimised copy is meaningfully smaller than the original.
 */
function hasWorthwhileSaving(originalSize, newSize, minSavingPercent = MIN_SAVING_PERCENT) {
  if (!(originalSize > 0) || !(newSize > 0)) return false;
  return newSize <= originalSize * (1 - minSavingPercent / 100);
}

/**
 * Mark a job as skipped because the optimised copy is not worth keeping.
 * Nothing is uploaded and the original is left untouched.
 */
async function skipJobWithoutSaving(job) {
  if (!(job.originalSize > 0) || !(job.newSize > 0)) {
    job.skipReason = 'Could not determine file sizes to confirm a saving — original kept';
  } else if (job.newSize >= job.originalSize) {
    job.skipReason = 'Optimised copy is larger than the original — original kept';
  } else {
    const savedPercent = ((job.originalSize - job.newSize) / job.originalSize) * 100;
    job.skipReason = `Optimised copy would only save ${savedPercent.toFixed(1)}% (minimum ${MIN_SAVING_PERCENT}%) — original kept`;
  }
  job.status = 'skipped';
  job.downloadAvailable = false;
  job.manualCleanupRequired = false;
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} skipping job - no worthwhile saving`, {
    jobId: job.jobId,
    originalSize: job.originalSize,
    newSize: job.newSize,
    skipReason: job.skipReason,
  });
}

/**
 * Core async processing pipeline for a single file optimisation job.
 */
async function processJob(jobId, item, tokens) {
  // Must be first and synchronous: a cancel that lands while this job is being
  // dequeued creates the controller, and we pick up its (aborted) signal here.
  const controller = getJobController(jobId);
  const { signal } = controller;
  const job = jobs[jobId] || await jobStore.loadJob(jobId);
  if (!job) {
    jobControllers.delete(jobId);
    throw new Error(`Job ${jobId} not found`);
  }
  jobs[jobId] = job;
  const { fileId, source } = item;
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `cdo_input_${jobId}`);
  const outputPath = path.join(tmpDir, `cdo_output_${jobId}.mov`);

  job.tempOutputPath = outputPath;
  job.downloadAvailable = false;

  console.log(`${LOG_PREFIX} starting job`, { jobId, fileId, source, tmpDir });
  try {
    throwIfCancelled(job);
    if (source === 'photos') {
      await processPhotosJob(job, tokens, item, inputPath, outputPath, signal);
    } else {
      await processDriveJob(job, tokens, fileId, inputPath, outputPath, signal);
    }
    console.log(`${LOG_PREFIX} job finished`, { jobId, status: job.status, newFileId: job.newFileId, uploadedTo: job.uploadedTo });
  } catch (err) {
    if ((signal.aborted || job.cancelRequested) && CANCELLABLE_STATUSES.has(job.status)) {
      // Any failure after a cancel (killed ffmpeg, aborted download, ...) is a
      // cancellation, not an error. Uploads are never started after a cancel.
      job.status = 'cancelled';
      job.error = null;
      job.progress = 0;
      job.downloadAvailable = false;
      await jobStore.saveJob(job);
      console.log(`${LOG_PREFIX} job cancelled`, { jobId });
      return;
    }
    job.status = 'error';
    job.error = err.message;
    await jobStore.saveJob(job);
    console.error(`${LOG_PREFIX} job error`, { jobId, error: err.message });
    throw err;
  } finally {
    await jobStore.saveJob(job).catch((err) => {
      console.error(`${LOG_PREFIX} failed to persist job state`, { jobId, error: err.message });
    });

    try {
      fs.unlinkSync(inputPath);
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        console.warn(`${LOG_PREFIX} failed to delete temp input file`, { path: inputPath, error: cleanupErr.message });
      }
    }

    if (job.status !== 'complete') {
      try {
        fs.unlinkSync(outputPath);
      } catch (cleanupErr) {
        if (cleanupErr.code !== 'ENOENT') {
          console.warn(`${LOG_PREFIX} failed to delete temp output file`, { path: outputPath, error: cleanupErr.message });
        }
      }
    }
    jobControllers.delete(jobId);
  }
}

// Jobs persisted before per-batch options existed have no targetHeight/crf.
function getJobSettings(job) {
  return {
    targetHeight: Number.isInteger(job.targetHeight) && job.targetHeight > 0 ? job.targetHeight : TARGET_HEIGHT,
    crf: Number.isInteger(job.crf) ? job.crf : VIDEO_CRF,
  };
}

async function processDriveJob(job, tokens, fileId, inputPath, outputPath, signal) {
  const drive = getDriveClient(tokens);

  job.status = 'fetching_metadata';
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} fetching Drive metadata`, { jobId: job.jobId, fileId });
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, parents, size, quotaBytesUsed, createdTime, videoMediaMetadata(width,height)',
  }, { signal });
  throwIfCancelled(job);

  job.fileName = meta.name;
  job.originalFileName = meta.name;
  job.captureTimestamp = meta.createdTime || null;
  console.log(`${LOG_PREFIX} Drive metadata fetched`, { jobId: job.jobId, fileId, name: meta.name, mimeType: meta.mimeType, size: meta.size });

  if (!meta.mimeType || !meta.mimeType.startsWith('video/')) {
    throw new Error(`File "${meta.name}" is not a video (mimeType: ${meta.mimeType})`);
  }

  throwIfCancelled(job);
  job.status = 'downloading';
  job.progress = 0;
  await jobStore.saveJob(job);
  await downloadFile(drive, fileId, inputPath, signal);
  throwIfCancelled(job);
  job.originalSize = getFileSize(inputPath) || parseInt(meta.size || meta.quotaBytesUsed || '0', 10);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} Drive file downloaded`, { jobId: job.jobId, originalSize: job.originalSize });

  const { targetHeight, crf } = getJobSettings(job);
  throwIfCancelled(job);
  job.status = 'transcoding';
  job.progress = 0;
  const driveOrientationIsPortrait = await determinePortraitOrientation(inputPath, meta.videoMediaMetadata || {});
  await transcodeVideo(
    inputPath,
    outputPath,
    { captureTimestamp: job.captureTimestamp },
    driveOrientationIsPortrait,
    (pct) => {
      if (signal?.aborted) return;
      job.progress = Math.round(pct);
      jobStore.saveJob(job).catch(() => {});
    },
    targetHeight,
    crf,
    signal
  );
  throwIfCancelled(job);
  job.progress = 100;
  job.newSize = getFileSize(outputPath);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} transcoding complete`, {
    jobId: job.jobId,
    newSize: job.newSize,
    isPortrait: driveOrientationIsPortrait,
  });

  throwIfCancelled(job);
  if (!hasWorthwhileSaving(job.originalSize, job.newSize)) {
    await skipJobWithoutSaving(job);
    return;
  }

  const optimisedName = buildOptimisedName(meta.name, targetHeight);
  // Last chance to stop: nothing synchronous separates this check from the
  // status change below, and 'uploading' can no longer be cancelled.
  throwIfCancelled(job);
  if (job.upload) {
    job.status = 'uploading';
    await jobStore.saveJob(job);
    const uploaded = await uploadFile(drive, outputPath, optimisedName, 'video/quicktime', meta.parents);

    job.status = 'trashing_original';
    await jobStore.saveJob(job);
    console.log(`${LOG_PREFIX} moving original Drive file to bin`, { jobId: job.jobId, fileId });
    await drive.files.update({ fileId, requestBody: { trashed: true } });
    console.log(`${LOG_PREFIX} original Drive file moved to bin`, { jobId: job.jobId, fileId });

    job.originalTrashed = true;
    job.status = 'complete';
    job.newFileId = uploaded.id;
    job.newFileName = uploaded.name;
    job.uploadedTo = 'drive';
    job.manualCleanupRequired = false;
    job.downloadAvailable = true;
    await jobStore.saveJob(job);
  } else {
    throwIfCancelled(job);
    job.status = 'complete';
    job.newFileName = optimisedName;
    job.uploadedTo = 'local';
    job.manualCleanupRequired = false;
    job.downloadAvailable = true;
    await jobStore.saveJob(job);
  }
}

async function processPhotosJob(job, tokens, item, inputPath, outputPath, signal) {
  console.log(`${LOG_PREFIX} processing Google Photos job`, { job, item });
  const mediaItemInput = item.mediaItem || null;
  const photoId = item.id || mediaItemInput?.id;
  const mediaFile = mediaItemInput?.mediaFile || mediaItemInput;
  console.log(`${LOG_PREFIX} mediafile`, { mediaFile });
  job.status = 'fetching_metadata';
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} fetching Photos metadata`, { jobId: job.jobId, photoId });

  const mediaItem = mediaFile || (photoId ? await getPhotoMediaItem(tokens, photoId) : null);
  throwIfCancelled(job);
  if (!mediaItem) {
    throw new Error('Missing Google Photos media item metadata for optimisation');
  }
  
  const photosMetadata = mediaFile.mediaMetadata || mediaFile.mediaFileMetadata || mediaItem.mediaMetadata || {};
  console.log(`${LOG_PREFIX} photosMetadata`, JSON.stringify(photosMetadata, null, 2));

  job.fileName = photosMetadata.filename || mediaItem.filename || mediaItem.id;
  job.originalFileName = photosMetadata.filename ||mediaItem.filename || mediaItem.id;
  job.captureTimestamp = photosMetadata.creationTime || mediaItem?.mediaMetadata?.creationTime || mediaItemInput?.createTime || null;
  job.fileId = mediaItem.id;
  job.mediaItem = mediaItem;
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} Photos metadata fetched`, {
    jobId: job.jobId,
    photoId,
    filename: job.fileName,
    mimeType: mediaItem.mimeType,
  });

  if (!mediaItem.mimeType || !mediaItem.mimeType.startsWith('video/')) {
    throw new Error(`File "${job.fileName}" is not a video (mimeType: ${mediaItem.mimeType})`);
  }

  throwIfCancelled(job);
  job.status = 'downloading';
  job.progress = 0;
  await jobStore.saveJob(job);
  await downloadPhotoVideo(tokens, mediaItem, inputPath, signal);
  throwIfCancelled(job);
  job.originalSize = getFileSize(inputPath);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} Photos file downloaded`, { jobId: job.jobId, originalSize: job.originalSize });

  const { targetHeight, crf } = getJobSettings(job);
  throwIfCancelled(job);
  job.status = 'transcoding';
  job.progress = 0;
  await jobStore.saveJob(job);
  const photosOrientationIsPortrait = await determinePortraitOrientation(inputPath, photosMetadata);
  await transcodeVideo(
    inputPath,
    outputPath,
    {
      ...photosMetadata,
      captureTimestamp: job.captureTimestamp,
    },
    photosOrientationIsPortrait,
    (pct) => {
      if (signal?.aborted) return;
      job.progress = Math.round(pct);
      jobStore.saveJob(job).catch(() => {})
    },
    targetHeight,
    crf,
    signal
  );
  throwIfCancelled(job);
  job.progress = 100;
  job.newSize = getFileSize(outputPath);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} transcoding complete`, {
    jobId: job.jobId,
    newSize: job.newSize,
    isPortrait: photosOrientationIsPortrait,
  });

  throwIfCancelled(job);
  if (!hasWorthwhileSaving(job.originalSize, job.newSize)) {
    await skipJobWithoutSaving(job);
    return;
  }

  const optimisedName = buildOptimisedName(job.originalFileName, targetHeight);

  // Last chance to stop: nothing synchronous separates this check from the
  // status change below, and 'uploading' can no longer be cancelled.
  throwIfCancelled(job);
  if (job.upload) {
    job.status = 'uploading';
    await jobStore.saveJob(job);
    const uploaded = await enqueuePhotosUpload(() => uploadPhotoVideo(
      tokens,
      outputPath,
      optimisedName,
      'video/quicktime',
      mediaItem.description || undefined,
      job.albumId || null
    ));
    await jobStore.saveJob(job);
    console.log(`${LOG_PREFIX} uploaded transcoded file to Photos`, { jobId: job.jobId, newMediaItemId: uploaded.id });

    job.status = 'complete';
    job.newFileId = uploaded.id;
    job.newFileName = uploaded.filename || optimisedName;
    job.newProductUrl = uploaded.productUrl || null;
    job.uploadedTo = 'photos';
    job.manualCleanupRequired = true;
    job.originalRemovedByUser = false;
    job.downloadAvailable = true;
    await jobStore.saveJob(job);
  } else {
    throwIfCancelled(job);
    job.status = 'complete';
    job.newFileName = optimisedName;
    job.uploadedTo = 'local';
    job.manualCleanupRequired = false;
    job.downloadAvailable = true;
    await jobStore.saveJob(job);
  }
}

/**
 * Derive a new filename for the re-encoded video.
 * e.g. "holiday.mov" → "holiday_720p.mov"
 */
function buildOptimisedName(originalName, height) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  return `${base}_${height}p.mov`;
}

module.exports = router;
module.exports.buildOptimisedName = buildOptimisedName;
module.exports.parseJobOptions = parseJobOptions;
module.exports.hasWorthwhileSaving = hasWorthwhileSaving;
module.exports.recoverInterruptedJobs = recoverInterruptedJobs;
module.exports.transcodeVideo = transcodeVideo;
module.exports.JobCancelledError = JobCancelledError;
