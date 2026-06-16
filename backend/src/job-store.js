'use strict';

const redisClient = require('./redis-client');

const JOB_TTL_SECONDS = 24 * 60 * 60;

function jobKey(jobId) {
  return `job:${jobId}`;
}

function sessionJobsKey(sessionId) {
  return `jobs:${sessionId}`;
}

async function saveJob(job) {
  if (!job || !job.jobId) return;
  await redisClient.set(jobKey(job.jobId), JSON.stringify(job), {
    EX: JOB_TTL_SECONDS,
  });
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

module.exports = {
  saveJob,
  loadJob,
  loadSessionJobs,
  saveJobWithSession,
  touchSessionJobs,
  clearSessionJobs,
};
