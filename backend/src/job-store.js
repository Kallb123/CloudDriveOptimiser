'use strict';

const redisClient = require('./redis-client');

const JOB_TTL_SECONDS = 24 * 60 * 60;
const ACTIVE_JOBS_KEY = 'jobs:active';
const TERMINAL_STATUSES = new Set(['complete', 'skipped', 'error']);
const INTERRUPTED_MESSAGE = 'Interrupted by a server restart — please try again';
const LATE_STAGE_STATUSES = new Set(['uploading', 'trashing_original']);
const INTERRUPTED_LATE_MESSAGE =
  'Interrupted by a server restart while uploading — check Drive / Google Photos for an existing optimised copy (and the Drive bin for the original) before retrying';

function jobKey(jobId) {
  return `job:${jobId}`;
}

function sessionJobsKey(sessionId) {
  return `jobs:${sessionId}`;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

async function saveJob(job) {
  if (!job || !job.jobId) return;
  // Keep the job payload and its membership of the active-job set in step
  // (single MULTI so the two can never be observed out of sync).
  const tx = redisClient.multi().set(jobKey(job.jobId), JSON.stringify(job), {
    EX: JOB_TTL_SECONDS,
  });
  if (isTerminalStatus(job.status)) {
    tx.sRem(ACTIVE_JOBS_KEY, job.jobId);
  } else {
    tx.sAdd(ACTIVE_JOBS_KEY, job.jobId);
  }
  await tx.exec();
}

async function loadJob(jobId) {
  if (!jobId) return null;
  const raw = await redisClient.get(jobKey(jobId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[job-store] failed to parse job payload', err.message);
    return null;
  }
}

async function addJobToSession(sessionId, jobId) {
  if (!sessionId || !jobId) return;
  const key = sessionJobsKey(sessionId);
  await redisClient.rPush(key, jobId);
  await redisClient.expire(key, JOB_TTL_SECONDS);
}

async function loadSessionJobs(sessionId) {
  if (!sessionId) return [];
  const key = sessionJobsKey(sessionId);
  const ids = await redisClient.lRange(key, 0, -1);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const jobs = await Promise.all(ids.map(loadJob));
  return jobs.filter(Boolean);
}

async function saveJobWithSession(job) {
  await saveJob(job);
  await addJobToSession(job.sessionId, job.jobId);
}

async function touchSessionJobs(sessionId) {
  if (!sessionId) return;
  await redisClient.expire(sessionJobsKey(sessionId), JOB_TTL_SECONDS);
}

async function clearSessionJobs(sessionId) {
  if (!sessionId) return;
  await redisClient.del(sessionJobsKey(sessionId));
}

/**
 * Wait (bounded) for the shared redis client to be ready. Commands issued
 * earlier would be queued by the client anyway; this just stops startup
 * hanging indefinitely if redis is down.
 */
function waitForRedisReady(timeoutMs) {
  if (redisClient.isReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      redisClient.off('ready', onReady);
      reject(new Error(`redis not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    function onReady() {
      clearTimeout(timer);
      resolve();
    }
    redisClient.once('ready', onReady);
  });
}

/**
 * Mark every job left in a non-terminal state (i.e. interrupted by a backend
 * restart) as failed. Only call this at startup, before new jobs are accepted:
 * any non-terminal job at that point has no process working on it.
 * Returns the recovered jobs.
 */
async function recoverInterruptedJobs({ readyTimeoutMs = 15000 } = {}) {
  await waitForRedisReady(readyTimeoutMs);
  const ids = await redisClient.sMembers(ACTIVE_JOBS_KEY);
  const recovered = [];
  for (const jobId of ids || []) {
    const job = await loadJob(jobId);
    if (!job) {
      // Job key expired (or was never written) — just drop the stale member.
      await redisClient.sRem(ACTIVE_JOBS_KEY, jobId);
      continue;
    }
    if (isTerminalStatus(job.status)) {
      await redisClient.sRem(ACTIVE_JOBS_KEY, jobId);
      continue;
    }
    // Past the upload step the optimised copy may already exist (and a Drive
    // original may already be in the bin), so a blind retry could duplicate it.
    job.error = LATE_STAGE_STATUSES.has(job.status)
      ? INTERRUPTED_LATE_MESSAGE
      : INTERRUPTED_MESSAGE;
    job.status = 'error';
    job.downloadAvailable = false;
    delete job.tempOutputPath;
    await saveJob(job); // terminal status => removed from the active set
    recovered.push(job);
  }
  return recovered;
}

module.exports = {
  isTerminalStatus,
  recoverInterruptedJobs,
  saveJob,
  loadJob,
  loadSessionJobs,
  saveJobWithSession,
  touchSessionJobs,
  clearSessionJobs,
};
