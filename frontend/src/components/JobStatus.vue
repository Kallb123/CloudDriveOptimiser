<!-- JobStatus.vue — shows in-progress / completed optimisation jobs -->
<template>
  <div class="job-status" v-if="jobs.length > 0">
    <h3>Optimisation Jobs</h3>
    <table class="table">
      <thead>
        <tr>
          <th>File</th>
          <th>Status</th>
          <th>Progress</th>
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
            <div class="progress-bar" v-if="job.status === 'transcoding'">
              <div class="progress-fill" :style="{ width: `${job.progress}%` }"></div>
              <span class="progress-label">{{ job.progress }}%</span>
            </div>
            <span v-else-if="job.status === 'error'" class="error-msg">{{ job.error }}</span>
            <span v-else class="progress-text">{{ statusDetail(job) }}</span>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="completedJobs.length > 0" class="completed-uploads">
      <div v-if="photosCleanupRequired" class="cleanup-note">
        Remove the original Google Photos videos manually to recover storage space.
      </div>

      <h3>Optimised Uploads</h3>
      <table class="table">
        <thead>
          <tr>
            <th>Original file</th>
            <th>Optimised file</th>
            <th>Original size</th>
            <th>New size</th>
            <th>Capture time</th>
            <th>Uploaded to</th>
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
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  jobs: { type: Array, default: () => [] },
})

const completedJobs = computed(() =>
  props.jobs.filter((job) => job.status === 'complete' && (job.newFileName || job.newFileId))
)

const photosCleanupRequired = computed(() =>
  completedJobs.value.some((job) => job.manualCleanupRequired)
)

const STATUS_LABELS = {
  queued: 'Queued',
  fetching_metadata: 'Fetching info',
  downloading: 'Downloading',
  transcoding: 'Transcoding',
  uploading: 'Uploading',
  deleting_original: 'Deleting original',
  complete: 'Complete',
  error: 'Error',
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

function statusDetail(job) {
  if (job.status === 'complete') {
    return job.manualCleanupRequired
      ? `✓ Uploaded "${job.newFileName}" to Google Photos`
      : `✓ Saved as "${job.newFileName}"`
  }
  if (job.status === 'downloading') {
    return job.source === 'photos' ? 'Downloading from Google Photos…' : 'Downloading from Drive…'
  }
  if (job.status === 'uploading') {
    return job.source === 'photos' ? 'Uploading to Google Photos…' : 'Uploading to Drive…'
  }
  if (job.status === 'deleting_original') return 'Removing original from Drive…'
  return ''
}

function formatSize(bytes) {
  if (bytes == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(1)} ${units[i]}`
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

.completed-uploads {
  margin-top: 1.5rem;
}

.cleanup-note {
  margin-bottom: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  background: #fffbea;
  border: 1px solid #f6e05e;
  color: #744210;
  font-size: 0.9rem;
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
.badge-deleting_original { background: #bee3f8; color: #2a4365; }
.badge-transcoding { background: #fefcbf; color: #744210; }
.badge-complete { background: #c6f6d5; color: #22543d; }
.badge-error { background: #fed7d7; color: #742a2a; }

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
