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
} = require('./photos-api');
const jobStore = require('./job-store');

const router = express.Router();
const jobs = {};

const TARGET_HEIGHT = parseInt(process.env.TRANSCODE_HEIGHT || '720', 10);
const VIDEO_CRF = parseInt(process.env.TRANSCODE_CRF || '28', 10);
const VIDEO_PRESET = process.env.VIDEO_PRESET || 'medium';
const LOG_PREFIX = '[optimise]';

const photosUploadMutex = {
  current: Promise.resolve(),
};

async function enqueuePhotosUpload(task) {
  const next = photosUploadMutex.current.then(() => task());
  // Keep the chain alive even if a task fails so subsequent uploads still run.
  photosUploadMutex.current = next.catch(() => {});
  return next;
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
async function downloadFile(drive, fileId, destPath) {
  console.log(`${LOG_PREFIX} downloading Drive file ${fileId} to ${destPath}`);
  const dest = fs.createWriteStream(destPath);
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    response.data
      .on('error', (err) => {
        console.error(`${LOG_PREFIX} download error for file ${fileId}:`, err.message);
        reject(err);
      })
      .pipe(dest)
      .on('error', (err) => {
        console.error(`${LOG_PREFIX} write error for ${destPath}:`, err.message);
        reject(err);
      })
      .on('finish', () => {
        console.log(`${LOG_PREFIX} completed download of Drive file ${fileId}`);
        resolve();
      });
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
 * Scales to TARGET_HEIGHT while preserving aspect ratio,
 * encodes with h264 at VIDEO_CRF quality.
 */
async function transcodeVideo(inputPath, outputPath, metadata, shouldUseWidth, onProgress) {
  console.log(`${LOG_PREFIX} transcoding video ${inputPath} to ${outputPath} with target height ${TARGET_HEIGHT} ${shouldUseWidth}`);
  const scaleArg = shouldUseWidth ? `${TARGET_HEIGHT}:-2` : `-2:${TARGET_HEIGHT}`;
  const originalDate = await getOriginalCreationTime(inputPath);
  const outputOptions = [
    '-map_metadata 0',
    `-vf scale=${scaleArg}`,
    '-c:v libx264',
    `-crf ${VIDEO_CRF}`,
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
  
    command
      .on('progress', (progress) => {
        if (typeof onProgress === 'function') {
          onProgress(progress.percent || 0);
        }
      })
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

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
 * Body: { fileIds: [string] }
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
      status: 'queued',
      progress: 0,
      error: null,
    };

    jobs[jobId] = job;
    await jobStore.saveJobWithSession(job);
    queuedJobs.push({ jobId, fileId, source, item });
  }

  const tokens = req.session.tokens;

  // Process jobs asynchronously
  queuedJobs.forEach(({ jobId, fileId, source, item }) => {
    console.log(`${LOG_PREFIX} queued optimisation job`, { jobId, fileId, source });
    processJob(jobId, item, tokens).catch((err) => {
      console.error(`${LOG_PREFIX} Job ${jobId} failed:`, err.message);
    });
  });

  return res.json({ jobs: queuedJobs.map(({ jobId, fileId, source, upload }) => ({ jobId, fileId, source, upload })) });
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
  let job = jobs[req.params.jobId];
  if (!job) {
    job = await jobStore.loadJob(req.params.jobId);
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
  return res.json({ jobs: sessionJobs.map(sanitizeJob) });
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
 * Core async processing pipeline for a single file optimisation job.
 */
async function processJob(jobId, item, tokens) {
  const job = jobs[jobId];
  const { fileId, source } = item;
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `cdo_input_${jobId}`);
  const outputPath = path.join(tmpDir, `cdo_output_${jobId}.mov`);

  job.tempOutputPath = outputPath;
  job.downloadAvailable = false;

  console.log(`${LOG_PREFIX} starting job`, { jobId, fileId, source, tmpDir });
  try {
    if (source === 'photos') {
      await processPhotosJob(job, tokens, item, inputPath, outputPath);
    } else {
      await processDriveJob(job, tokens, fileId, inputPath, outputPath);
    }
    console.log(`${LOG_PREFIX} job complete`, { jobId, newFileId: job.newFileId, uploadedTo: job.uploadedTo });
  } catch (err) {
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
  }
}

async function processDriveJob(job, tokens, fileId, inputPath, outputPath) {
  const drive = getDriveClient(tokens);

  job.status = 'fetching_metadata';
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} fetching Drive metadata`, { jobId: job.jobId, fileId });
  const { data: meta } = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, parents, size, quotaBytesUsed, createdTime, videoMediaMetadata(width,height)',
  });

  job.fileName = meta.name;
  job.originalFileName = meta.name;
  job.captureTimestamp = meta.createdTime || null;
  console.log(`${LOG_PREFIX} Drive metadata fetched`, { jobId: job.jobId, fileId, name: meta.name, mimeType: meta.mimeType, size: meta.size });

  if (!meta.mimeType || !meta.mimeType.startsWith('video/')) {
    throw new Error(`File "${meta.name}" is not a video (mimeType: ${meta.mimeType})`);
  }

  job.status = 'downloading';
  job.progress = 0;
  await jobStore.saveJob(job);
  await downloadFile(drive, fileId, inputPath);
  job.originalSize = getFileSize(inputPath) || parseInt(meta.size || meta.quotaBytesUsed || '0', 10);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} Drive file downloaded`, { jobId: job.jobId, originalSize: job.originalSize });

  job.status = 'transcoding';
  job.progress = 0;
  const driveOrientationIsPortrait = await determinePortraitOrientation(inputPath, meta.videoMediaMetadata || {});
  await transcodeVideo(
    inputPath,
    outputPath,
    { captureTimestamp: job.captureTimestamp },
    driveOrientationIsPortrait,
    (pct) => {
      job.progress = Math.round(pct);
      jobStore.saveJob(job);
    }
  );
  job.progress = 100;
  job.newSize = getFileSize(outputPath);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} transcoding complete`, {
    jobId: job.jobId,
    newSize: job.newSize,
    isPortrait: driveOrientationIsPortrait,
  });

  const optimisedName = buildOptimisedName(meta.name, TARGET_HEIGHT);
  if (job.upload) {
    job.status = 'uploading';
    const uploaded = await uploadFile(drive, outputPath, optimisedName, 'video/quicktime', meta.parents);

    job.status = 'deleting_original';
    console.log(`${LOG_PREFIX} deleting original Drive file`, { jobId: job.jobId, fileId });
    await drive.files.delete({ fileId });
    console.log(`${LOG_PREFIX} original Drive file deleted`, { jobId: job.jobId, fileId });

    job.status = 'complete';
    job.newFileId = uploaded.id;
    job.newFileName = uploaded.name;
    job.uploadedTo = 'drive';
    job.manualCleanupRequired = false;
    job.downloadAvailable = true;
    await jobStore.saveJob(job);
  } else {
    job.status = 'complete';
    job.newFileName = optimisedName;
    job.uploadedTo = 'local';
    job.manualCleanupRequired = false;
    job.downloadAvailable = true;
    await jobStore.saveJob(job);
  }
}

async function processPhotosJob(job, tokens, item, inputPath, outputPath) {
  console.log(`${LOG_PREFIX} processing Google Photos job`, { job, item });
  const mediaItemInput = item.mediaItem || null;
  const photoId = item.id || mediaItemInput?.id;
  const mediaFile = mediaItemInput?.mediaFile || mediaItemInput;
  console.log(`${LOG_PREFIX} mediafile`, { mediaFile });
  job.status = 'fetching_metadata';
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} fetching Photos metadata`, { jobId: job.jobId, photoId });

  const mediaItem = mediaFile || (photoId ? await getPhotoMediaItem(tokens, photoId) : null);
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

  job.status = 'downloading';
  job.progress = 0;
  await jobStore.saveJob(job);
  await downloadPhotoVideo(tokens, mediaItem, inputPath);
  job.originalSize = getFileSize(inputPath);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} Photos file downloaded`, { jobId: job.jobId, originalSize: job.originalSize });

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
      job.progress = Math.round(pct);
      jobStore.saveJob(job).catch(() => {})
    }
  );
  job.progress = 100;
  job.newSize = getFileSize(outputPath);
  await jobStore.saveJob(job);
  console.log(`${LOG_PREFIX} transcoding complete`, {
    jobId: job.jobId,
    newSize: job.newSize,
    isPortrait: photosOrientationIsPortrait,
  });

  const optimisedName = buildOptimisedName(job.originalFileName, TARGET_HEIGHT);

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
    job.uploadedTo = 'photos';
    job.manualCleanupRequired = true;
    job.downloadAvailable = true;
    await jobStore.saveJob(job);
  } else {
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
