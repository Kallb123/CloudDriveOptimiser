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
  </div>
</template>

<script setup>
defineProps({
  jobs: { type: Array, default: () => [] },
})

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
  if (job.status === 'complete') return `✓ Saved as "${job.newFileName}"`
  if (job.status === 'downloading') return 'Downloading from Drive…'
  if (job.status === 'uploading') return 'Uploading to Drive…'
  if (job.status === 'deleting_original') return 'Removing original…'
  return ''
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
