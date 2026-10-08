<!-- JobStatus.vue — shows in-progress / completed optimisation jobs -->
<template>
  <div class="job-status" v-if="jobs.length > 0">
    <div class="status-header">
      <h3>Optimisation Jobs</h3>
      <button class="btn btn-sm btn-secondary clear-button" @click="$emit('clear')">
        Clear history
      </button>
    </div>
    <table class="table">
      <thead>
        <tr>
          <th>File</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="job.jobId" :class="`status-${job.status}`">
          <td>{{ job.fileName || job.fileId }}</td>
          <td>
            <span class="badge" :class="`badge-${job.status}`">
              {{ statusLabel(job.status) }}
            </span>
          </td>
          <td>
            <span v-if="isCancelling(job)" class="progress-text">Cancelling…</span>
            <div class="progress-bar" v-else-if="job.status === 'transcoding'">
              <div class="progress-fill" :style="{ width: `${job.progress}%` }"></div>
              <span class="progress-label">{{ job.progress }}%</span>
            </div>
            <span v-else-if="job.status === 'error'" class="error-msg">{{ job.error }}</span>
            <span v-else class="progress-text">{{ statusDetail(job) }}</span>
          </td>
          <td class="actions-cell">
            <div class="actions">
              <button
                v-if="canCancel(job)"
                class="btn btn-sm btn-secondary action-button cancel-button"
                :disabled="isPending(job)"
                @click="$emit('cancel', job.jobId)"
              >
                Cancel
              </button>
              <button
                v-if="canRetry(job) && !isRetryWarningOpen(job)"
                class="btn btn-sm btn-secondary action-button retry-button"
                :disabled="isPending(job)"
                @click="onRetryClick(job)"
              >
                Retry
              </button>
              <span v-if="job.retryCount > 0" class="retry-count">Retried {{ job.retryCount }}×</span>
            </div>
            <div v-if="canRetry(job) && isRetryWarningOpen(job)" class="retry-warning" role="alert">
              <p>
                This job was interrupted while {{ interruptedLabel(job) }} — an optimised copy may
                already exist in {{ job.source === 'photos' ? 'Google Photos' : 'Drive' }}<template v-if="job.source !== 'photos'">
                (and the Drive original may be in the bin)</template>. Check before retrying.
              </p>
              <div class="actions">
                <button
                  class="btn btn-sm btn-secondary action-button retry-button retry-anyway-button"
                  :disabled="isPending(job)"
                  @click="confirmRetry(job)"
                >
                  Retry anyway
                </button>
                <button
                  class="btn btn-sm btn-secondary action-button"
                  @click="closeRetryWarning(job)"
                >
                  Keep as is
                </button>
              </div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="cleanupJobs.length > 0" class="cleanup-section">
      <h3>Google Photos cleanup</h3>
      <div class="cleanup-banner" :class="{ 'cleanup-banner-done': cleanupRemaining.length === 0 }">
        <p v-if="cleanupRemaining.length > 0" class="cleanup-summary">
          <strong>{{ cleanupRemaining.length }} of {{ cleanupJobs.length }}</strong>
          Google Photos originals still to remove<template v-if="cleanupRemainingSize > 0">
          (~{{ formatSize(cleanupRemainingSize) }} to recover)</template>
        </p>
        <p v-else class="cleanup-summary">
          ✓ All Google Photos originals marked as removed
        </p>
        <p class="cleanup-explainer">
          Google doesn't let apps delete photos, so remove each original yourself, then tick it off.
          <a
            v-if="photosAlbumUrl"
            :href="photosAlbumUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="cleanup-link"
          >Open the app's album</a>
        </p>
      </div>

      <table class="table cleanup-table">
        <thead>
          <tr>
            <th>Removed</th>
            <th>Original file</th>
            <th>Capture time</th>
            <th>Original size</th>
            <th>Links</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="job in cleanupJobs"
            :key="`${job.jobId}-cleanup`"
            :class="{ 'cleanup-done': job.originalRemovedByUser }"
          >
            <td>
              <label class="cleanup-check">
                <input
                  type="checkbox"
                  :checked="!!job.originalRemovedByUser"
                  :disabled="isPending(job)"
                  @change="$emit('cleanup', { jobId: job.jobId, removed: $event.target.checked, input: $event.target })"
                />
                <span>Removed</span>
              </label>
            </td>
            <td class="cleanup-name">{{ job.originalFileName || job.fileName || job.fileId }}</td>
            <td>{{ formatDateTime(job.captureTimestamp) }}</td>
            <td>{{ formatSize(job.originalSize) }}</td>
            <td>
              <div class="cleanup-links">
                <a
                  :href="searchUrl(job)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="cleanup-link"
                >Search in Google Photos</a>
                <a
                  v-if="job.newProductUrl"
                  :href="job.newProductUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="cleanup-link"
                >View optimised copy</a>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="completedJobs.length > 0" class="completed-uploads">
      <div v-if="downloadError" class="download-error" role="alert">
        <span>{{ downloadError }}</span>
        <button class="download-error-close" @click="downloadError = null" aria-label="Dismiss error">×</button>
      </div>

      <div class="completed-header">
        <h3>Optimised Uploads</h3>
        <button
          class="btn btn-sm btn-primary download-all-button"
          :disabled="!completedJobs.length"
          @click="downloadAll"
        >
          Download All
        </button>
      </div>

      <table class="table">
        <thead>
          <tr>
            <th>Original file</th>
            <th>Optimised file</th>
            <th>Original size</th>
            <th>New size</th>
            <th>Capture time</th>
            <th>Uploaded to</th>
            <th>Download</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in completedJobs" :key="`${job.jobId}-result`">
            <td>{{ job.originalFileName || job.fileName || job.fileId }}</td>
            <td>{{ job.newFileName || '—' }}</td>
            <td>{{ formatSize(job.originalSize) }}</td>
            <td>{{ formatSize(job.newSize) }}</td>
            <td>{{ formatDateTime(job.captureTimestamp) }}</td>
            <td>{{ destinationLabel(job.uploadedTo) }}</td>
            <td>
              <button
                class="btn btn-sm btn-secondary download-button"
                @click="downloadJob(job.jobId, job.newFileName)"
              >
                Download
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import axios from 'axios'
import { formatSize } from '../utils/estimate.js'

const props = defineProps({
  jobs: { type: Array, default: () => [] },
  photosAlbumUrl: { type: String, default: null },
  pendingJobIds: { type: Object, default: () => new Set() },
})

const emit = defineEmits(['clear', 'cancel', 'retry', 'cleanup'])

const downloadError = ref(null)

const TERMINAL_STATUSES = new Set(['complete', 'skipped', 'error', 'cancelled'])
const CANCELLABLE_STATUSES = new Set(['queued', 'fetching_metadata', 'downloading', 'transcoding'])
const RETRYABLE_STATUSES = new Set(['error', 'cancelled'])
// Stages after which a retry could duplicate an upload.
const RISKY_INTERRUPTED_STAGES = new Set(['uploading', 'trashing_original'])

// jobIds whose "retry may duplicate" warning is currently revealed
const retryWarningIds = ref(new Set())

const completedJobs = computed(() =>
  props.jobs.filter((job) => job.status === 'complete' && job.downloadAvailable && (job.newFileName || job.newFileId))
)

const cleanupJobs = computed(() =>
  props.jobs.filter((job) => job.status === 'complete' && job.manualCleanupRequired)
)

const cleanupRemaining = computed(() =>
  cleanupJobs.value.filter((job) => !job.originalRemovedByUser)
)

const cleanupRemainingSize = computed(() =>
  cleanupRemaining.value.reduce(
    (sum, job) => sum + (typeof job.originalSize === 'number' && job.originalSize > 0 ? job.originalSize : 0),
    0
  )
)

function searchUrl(job) {
  return `https://photos.google.com/search/${encodeURIComponent(job.originalFileName || job.fileName || '')}`
}

function isPending(job) {
  return props.pendingJobIds.has(job.jobId)
}

function isCancelling(job) {
  return !!job.cancelRequested && !TERMINAL_STATUSES.has(job.status)
}

function canCancel(job) {
  return CANCELLABLE_STATUSES.has(job.status) && !job.cancelRequested
}

function canRetry(job) {
  return RETRYABLE_STATUSES.has(job.status)
}

function needsRetryWarning(job) {
  return RISKY_INTERRUPTED_STAGES.has(job.interruptedStage)
}

function isRetryWarningOpen(job) {
  return retryWarningIds.value.has(job.jobId)
}

function interruptedLabel(job) {
  return job.interruptedStage === 'trashing_original' ? 'moving the original to the bin' : 'uploading'
}

function onRetryClick(job) {
  if (needsRetryWarning(job)) {
    retryWarningIds.value.add(job.jobId)
    return
  }
  emit('retry', job.jobId)
}

function confirmRetry(job) {
  retryWarningIds.value.delete(job.jobId)
  emit('retry', job.jobId)
}

function closeRetryWarning(job) {
  retryWarningIds.value.delete(job.jobId)
}

function buildDownloadLink(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename || 'optimised-video.mov'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function downloadJob(jobId, filename) {
  downloadError.value = null
  try {
    const response = await axios.get(`/api/optimise/download/${encodeURIComponent(jobId)}`, {
      responseType: 'blob',
      withCredentials: true,
    })
    buildDownloadLink(response.data, filename || `job-${jobId}.mov`)
  } catch (err) {
    console.error('Failed to download job', err)
    downloadError.value = 'Unable to download this file. Please try again.'
  }
}

async function downloadAll() {
  downloadError.value = null
  try {
    const response = await axios.get('/api/optimise/download-all', {
      responseType: 'blob',
      withCredentials: true,
    })
    buildDownloadLink(response.data, 'cdo-optimised-videos.zip')
  } catch (err) {
    console.error('Failed to download all jobs', err)
    downloadError.value = 'Unable to download all files. Please try again.'
  }
}

const STATUS_LABELS = {
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

function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

function statusDetail(job) {
  if (job.status === 'complete') {
    if (job.manualCleanupRequired) {
      return `✓ Uploaded "${job.newFileName}" to Google Photos`
    }
    if (job.upload === false) {
      return `✓ Optimised copy ready for download as "${job.newFileName}"`
    }
    if (job.originalTrashed) {
      return `✓ Saved as "${job.newFileName}" — original moved to Drive bin`
    }
    return `✓ Saved as "${job.newFileName}"`
  }
  if (job.status === 'skipped') {
    return job.skipReason || 'No meaningful saving — original kept'
  }
  if (job.status === 'cancelled') return 'Cancelled — original left untouched'
  if (job.status === 'downloading') {
    return job.source === 'photos' ? 'Downloading from Google Photos…' : 'Downloading from Drive…'
  }
  if (job.status === 'uploading') {
    return job.source === 'photos' ? 'Uploading to Google Photos…' : 'Uploading to Drive…'
  }
  if (job.status === 'trashing_original') return 'Moving original to Drive bin…'
  return ''
}

function formatDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function destinationLabel(destination) {
  return destination === 'photos' ? 'Google Photos' : destination === 'drive' ? 'Drive' : '—'
}
</script>

<style scoped>
.job-status {
  margin-top: 2rem;
}

.job-status h3 {
  margin-bottom: 0.75rem;
  font-size: 1.1rem;
  color: #2d3748;
}

.status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.clear-button {
  border: 1px solid #cbd5e0;
  background: white;
  color: #2d3748;
  padding: 0.45rem 0.85rem;
  border-radius: 9999px;
  font-size: 0.8rem;
  cursor: pointer;
}

.clear-button:hover {
  background: #edf2f7;
}

.completed-uploads {
  margin-top: 1.5rem;
}

.cleanup-section {
  margin-top: 1.5rem;
}

.cleanup-banner {
  margin-bottom: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  background: #fefcbf;
  border: 1px solid #f6e05e;
  color: #744210;
  font-size: 0.9rem;
}

.cleanup-banner-done {
  background: #c6f6d5;
  border-color: #9ae6b4;
  color: #22543d;
}

.cleanup-summary {
  font-size: 0.95rem;
}

.cleanup-explainer {
  margin-top: 0.25rem;
  font-size: 0.85rem;
}

.cleanup-banner .cleanup-link {
  color: inherit;
  text-decoration: underline;
  font-weight: 600;
  margin-left: 0.35rem;
}

.cleanup-check {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.cleanup-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
}

.cleanup-link {
  color: #3182ce;
  font-size: 0.85rem;
  text-decoration: none;
}

.cleanup-link:hover {
  text-decoration: underline;
}

.cleanup-table tr.cleanup-done td {
  color: #718096;
}

.cleanup-table tr.cleanup-done .cleanup-name {
  text-decoration: line-through;
}

.actions-cell {
  min-width: 130px;
}

.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.action-button {
  border: 1px solid #cbd5e0;
  background: white;
  color: #2d3748;
  padding: 0.3rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.8rem;
  cursor: pointer;
}

.action-button:not(:disabled):hover {
  background: #edf2f7;
}

.action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.retry-button {
  border-color: #3182ce;
  color: #3182ce;
}

.retry-count {
  color: #718096;
  font-size: 0.75rem;
}

.retry-warning {
  margin-top: 0.4rem;
  padding: 0.5rem 0.75rem;
  max-width: 300px;
  border-radius: 8px;
  background: #fefcbf;
  border: 1px solid #f6e05e;
  color: #744210;
  font-size: 0.8rem;
}

.retry-warning p {
  margin-bottom: 0.4rem;
  line-height: 1.4;
}

.download-error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
  padding: 0.6rem 1rem;
  border-radius: 8px;
  background: #fff5f5;
  border: 1px solid #fed7d7;
  color: #c53030;
  font-size: 0.85rem;
}

.download-error-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.download-error-close:hover {
  opacity: 0.75;
}

.completed-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.download-button,
.download-all-button {
  border: 1px solid #cbd5e0;
  background: white;
  color: #2d3748;
  padding: 0.35rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.8rem;
  cursor: pointer;
}

.download-all-button {
  background: #3182ce;
  color: white;
  border-color: #2c5282;
}

.download-button:hover,
.download-all-button:hover {
  background: #edf2f7;
}

.download-all-button:hover {
  background: #2b6cb0;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.table th,
.table td {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #e2e8f0;
  text-align: left;
  vertical-align: middle;
}

.table th {
  background: #f7fafc;
  font-weight: 600;
  color: #4a5568;
}

.badge {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.badge-queued { background: #e2e8f0; color: #4a5568; }
.badge-fetching_metadata,
.badge-downloading,
.badge-uploading,
.badge-trashing_original { background: #bee3f8; color: #2a4365; }
.badge-transcoding { background: #fefcbf; color: #744210; }
.badge-complete { background: #c6f6d5; color: #22543d; }
.badge-skipped { background: #fefcbf; color: #744210; }
.badge-error { background: #fed7d7; color: #742a2a; }
.badge-cancelled { background: #edf2f7; color: #4a5568; }

.progress-bar {
  position: relative;
  height: 18px;
  background: #e2e8f0;
  border-radius: 9999px;
  overflow: hidden;
  min-width: 120px;
}

.progress-fill {
  height: 100%;
  background: #3182ce;
  transition: width 0.3s ease;
  border-radius: 9999px;
}

.progress-label {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 18px;
  color: #2d3748;
}

.error-msg {
  color: #c53030;
  font-size: 0.8rem;
}

.progress-text {
  color: #718096;
  font-size: 0.85rem;
}
</style>
