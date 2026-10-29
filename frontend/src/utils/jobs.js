// jobs.js — shared helpers for optimisation job state in the UI.

export const TERMINAL_STATUSES = new Set(['complete', 'skipped', 'error', 'cancelled'])

export const STATUS_LABELS = {
  queued: 'Queued',
  fetching_metadata: 'Fetching info',
  downloading: 'Downloading',
  transcoding: 'Transcoding',
  uploading: 'Uploading',
  trashing_original: 'Moving original to bin',
  complete: 'Complete',
  skipped: 'Skipped',
  error: 'Error',
  cancelled: 'Cancelled',
}

export function isJobFinished(job) {
  return TERMINAL_STATUSES.has(job.status)
}

// Jobs that failed or were cancelled left the original untouched, so the file
// is still waiting to be optimised.
export function isJobRetryable(job) {
  return job.status === 'error' || job.status === 'cancelled'
}

export function fileKey(source, id) {
  return `${source || 'drive'}:${id}`
}

// Map of fileKey -> the most recent job for that file.
export function latestJobByFile(jobs) {
  const map = new Map()
  for (const job of jobs || []) {
    if (!job?.fileId) continue
    const key = fileKey(job.source, job.fileId)
    const existing = map.get(key)
    if (!existing || (job.createdAt || 0) >= (existing.createdAt || 0)) {
      map.set(key, job)
    }
  }
  return map
}
