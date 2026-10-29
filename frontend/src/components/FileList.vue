<!-- FileList.vue — displays analysed files sorted by size -->
<template>
  <div class="file-list">
    <div class="toolbar">
      <label class="toggle btn btn-secondary">
        <input type="checkbox" v-model="showThumbnails" />
        Show thumbnails
      </label>
      <label style="margin-right: 0.5rem">
        <span style="margin-right: 0.2rem;">Filter filename: </span>
        <input
          type="text"
          v-model="filenameFilter"
          placeholder="Filter by filename"
        />
      </label>
      <label v-if="latestPickAt" class="toggle btn btn-secondary">
        <input type="checkbox" v-model="onlyLatestPick" />
        Only latest Google Photos pick ({{ latestPickCount }})
      </label>
      <button
        class="btn btn-primary"
        :disabled="selectedFiles.length === 0 || starting"
        @click="$emit('optimise', selectedFiles)"
      >
        {{ starting ? 'Starting…' : `Optimise selected (${selectedFiles.length})` }}
      </button>
    </div>

    <div
      v-if="readyFiles.length > 0 || processedFiles.length > 0"
      class="summary-bar"
      title="Rough estimate based on resolution and duration"
    >
      <span v-if="readyFiles.length > 0">
        <strong>{{ overall.count }}</strong>
        {{ overall.count === 1 ? 'video' : 'videos' }} ready to optimise
        · {{ formatSize(overall.totalSize) }}
        · est. saving <strong>~{{ formatSize(overall.estimatedSaving) }}</strong>
        <span v-if="overall.unknownCount > 0" class="summary-muted">
          ({{ overall.unknownCount }} without enough info to estimate)
        </span>
      </span>
      <span v-else>Nothing left to optimise here.</span>
      <span v-if="processedFiles.length > 0" class="summary-muted">
        {{ processedFiles.length }} already processed or in progress
      </span>
      <span v-if="selectedFiles.length > 0" class="summary-selected">
        Selected: <strong>{{ selectedFiles.length }}</strong>
        · {{ formatSize(selection.totalSize) }} → ~{{ formatSize(selection.estimatedSize) }}
        <span v-if="selection.unknownCount > 0" class="summary-muted">
          ({{ selection.unknownCount }} without enough info to estimate)
        </span>
      </span>
    </div>

    <div v-if="files.length === 0" class="empty">
      No files found. Click <strong>Analyse</strong> to load your files.
    </div>

    <div v-else-if="filteredFiles.length === 0" class="empty">
      No files match the current filters.
    </div>

    <table v-else class="table">
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              @change="toggleAll"
              :checked="allSelected"
              :disabled="readyFiles.length === 0"
              title="Select all videos ready to optimise"
            />
          </th>
          <th v-if="showThumbnails">Thumbnail</th>
          <th>Name</th>
          <th>Size ▼</th>
          <th title="Rough estimate based on resolution and duration">Est. saving</th>
          <th>Resolution</th>
          <th>Uploaded</th>
          <th>Source</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody v-for="section in sections" :key="section.key" :class="`section-${section.key}`">
        <tr class="section-heading">
          <td :colspan="columnCount">
            {{ section.title }} ({{ section.files.length }})
            <button
              v-if="section.collapsible"
              class="section-toggle"
              @click="toggleSection(section.key)"
            >
              {{ isCollapsed(section.key) ? 'Show' : 'Hide' }}
            </button>
            <span v-if="section.hint" class="section-hint">{{ section.hint }}</span>
          </td>
        </tr>
        <template v-if="!isCollapsed(section.key)">
          <tr
            v-for="file in section.files"
            :key="fileKey(file.source, file.id)"
            :class="{
              selected: selectedIds.includes(file.id),
              'video-row': file.isVideo,
              'new-row': isLatestPick(file) && section.key === 'ready',
            }"
          >
            <td>
              <input
                type="checkbox"
                :value="file.id"
                v-model="selectedIds"
                :disabled="section.key !== 'ready'"
                :title="checkboxTitle(file)"
              />
            </td>
            <td v-if="showThumbnails" class="thumb-cell">
              <img
                v-if="file.source === 'photos' && file.thumbnailLink"
                :src="file.thumbnailLink"
                :alt="file.name"
                class="thumbnail"
                loading="lazy"
              />
              <img
                v-else-if="file.source !== 'photos' && file.thumbnailLink"
                :src="`/api/drive/thumbnail/${file.id}`"
                :alt="file.name"
                class="thumbnail"
                loading="lazy"
              />
              <span v-else class="no-thumb">—</span>
            </td>
            <td class="name-cell">
              <a :href="file.webViewLink" target="_blank" rel="noopener noreferrer">
                {{ file.name }}
              </a>
              <span v-if="isLatestPick(file)" class="tag tag-new" title="Added in your latest Google Photos pick">New</span>
              <span
                v-if="jobFor(file)"
                class="tag"
                :class="`tag-job-${jobFor(file).status}`"
                :title="jobFor(file).error || ''"
              >
                {{ jobLabel(jobFor(file)) }}
              </span>
              <span v-if="file.isVideo && file.alreadyOptimised" class="tag">
                {{ file.notOptimisableReason || 'Already ≤720p' }}
              </span>
            </td>
            <td class="size-cell">{{ sizeLabel(file) }}</td>
            <td class="saving-cell" title="Rough estimate based on resolution and duration">{{ savingLabel(file) }}</td>
            <td class="resolution-cell">{{ fileResolution(file) }}</td>
            <td class="date-cell">{{ formatDate(file.createdTime) }}</td>
            <td class="source-cell">{{ sourceLabel(file.source) }}</td>
            <td class="type-cell">{{ shortMime(file.mimeType) }}</td>
          </tr>
        </template>
      </tbody>
    </table>

    <div v-if="nextPageToken" class="load-more">
      <button class="btn btn-secondary" @click="$emit('load-more')" :disabled="loading">
        {{ loading ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { formatSize, estimateSaving, summariseEstimates } from '../utils/estimate.js'
import { STATUS_LABELS, fileKey, isJobRetryable } from '../utils/jobs.js'

const props = defineProps({
  files: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  // A start request is in flight. Jobs already running don't block queueing more.
  starting: { type: Boolean, default: false },
  nextPageToken: { type: String, default: null },
  // Default { targetHeight, crf } used for the estimates shown in the list.
  settings: { type: Object, default: () => ({ targetHeight: 720, crf: 28 }) },
  // Map of fileKey(source, id) -> latest optimisation job for that file.
  jobsByFile: { type: Map, default: () => new Map() },
})

const emit = defineEmits(['optimise', 'refresh', 'load-more'])

defineExpose({ selectLatestPick })

const showThumbnails = ref(false)
const filenameFilter = ref('')
const onlyLatestPick = ref(false)
const selectedIds = ref([])
const collapsedSections = ref(new Set(['processed']))

// Timestamp of the most recent Google Photos pick, or null.
const latestPickAt = computed(() => {
  let latest = 0
  for (const file of props.files) {
    if (file.source === 'photos' && file.pickedAt > latest) latest = file.pickedAt
  }
  return latest || null
})

const latestPickCount = computed(() => props.files.filter(isLatestPick).length)

watch(latestPickAt, (value) => {
  if (!value) onlyLatestPick.value = false
})

const filteredFiles = computed(() => {
  const query = filenameFilter.value.trim().toLowerCase()
  return props.files.filter((file) => {
    if (onlyLatestPick.value && !isLatestPick(file)) return false
    return !query || file.name?.toLowerCase().includes(query)
  })
})

const bySizeDesc = (a, b) => (b.size || 0) - (a.size || 0)

// Optimisable files are "ready" unless a job is running for them or has
// already finished with them (failed/cancelled jobs leave them ready).
const readyFiles = computed(() =>
  filteredFiles.value.filter((f) => f.optimisable && !isProcessed(f)).sort(bySizeDesc)
)
const processedFiles = computed(() =>
  filteredFiles.value.filter((f) => f.optimisable && isProcessed(f)).sort(bySizeDesc)
)
const otherFiles = computed(() =>
  filteredFiles.value.filter((f) => !f.optimisable).sort(bySizeDesc)
)

const sections = computed(() =>
  [
    { key: 'ready', title: 'Ready to optimise', files: readyFiles.value },
    {
      key: 'processed',
      title: 'Already processed or in progress',
      files: processedFiles.value,
      collapsible: true,
      hint: 'See Optimisation Jobs below for details',
    },
    { key: 'other', title: 'Not optimisable', files: otherFiles.value, collapsible: true },
  ].filter((section) => section.files.length > 0)
)

const columnCount = computed(() => (showThumbnails.value ? 9 : 8))

const readyIds = computed(() =>
  new Set(props.files.filter((f) => f.optimisable && !isProcessed(f)).map((f) => f.id))
)
const selectedFiles = computed(() =>
  props.files.filter((file) => readyIds.value.has(file.id) && selectedIds.value.includes(file.id))
)
const overall = computed(() => summariseEstimates(readyFiles.value, props.settings))
const selection = computed(() => summariseEstimates(selectedFiles.value, props.settings))
const allSelected = computed(
  () => readyFiles.value.length > 0 && readyFiles.value.every((f) => selectedIds.value.includes(f.id))
)

// Drop selections for files that left the list or started processing.
watch(readyIds, (ids) => {
  const kept = selectedIds.value.filter((id) => ids.has(id))
  if (kept.length !== selectedIds.value.length) selectedIds.value = kept
})

function jobFor(file) {
  return props.jobsByFile.get(fileKey(file.source, file.id)) || null
}

function isProcessed(file) {
  const job = jobFor(file)
  return !!job && !isJobRetryable(job)
}

function isLatestPick(file) {
  return !!latestPickAt.value && file.source === 'photos' && file.pickedAt === latestPickAt.value
}

// Select exactly the ready videos from the latest Google Photos pick.
function selectLatestPick() {
  selectedIds.value = props.files
    .filter((file) => isLatestPick(file) && readyIds.value.has(file.id))
    .map((file) => file.id)
}

function isCollapsed(key) {
  return collapsedSections.value.has(key)
}

function toggleSection(key) {
  const next = new Set(collapsedSections.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedSections.value = next
}

function jobLabel(job) {
  if (job.status === 'transcoding') return `Transcoding ${job.progress || 0}%`
  if (job.status === 'complete') return '✓ Optimised'
  if (job.status === 'skipped') return 'Skipped — no saving'
  if (job.status === 'error') return 'Last attempt failed'
  return STATUS_LABELS[job.status] || job.status
}

function toggleAll(e) {
  if (e.target.checked) {
    selectedIds.value = readyFiles.value.map((f) => f.id)
  } else {
    selectedIds.value = []
  }
}

function checkboxTitle(file) {
  if (file.optimisable && isProcessed(file)) return 'Already processed or in progress'
  if (file.optimisable && file.source === 'photos') return 'Select Google Photos video for optimisation'
  if (file.optimisable) return 'Select Drive video for optimisation'
  return file.notOptimisableReason || 'Only video files can be optimised'
}

function sizeLabel(file) {
  if (file.size == null) return '—'
  return `${file.source === 'photos' ? '~' : ''}${formatSize(file.size)}`
}

function savingLabel(file) {
  if (!file.optimisable || !file.isVideo) return '—'
  const saving = estimateSaving(file, props.settings)
  if (saving === null) return '—'
  const pct = file.size > 0 ? Math.round((saving / file.size) * 100) : 0
  return `~${formatSize(saving)} (${pct}%)`
}

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function shortMime(mime) {
  if (!mime) return '—'
  const parts = mime.split('/')
  return parts[parts.length - 1].replace(/^vnd\.google-apps\./, '')
}

function sourceLabel(source) {
  return source === 'photos' ? 'Google Photos' : 'Drive'
}

function fileResolution(file) {
  if (file.resolution) return file.resolution
  if (file.width && file.height) return `${file.width}×${file.height}`
  return '—'
}
</script>

<style scoped>
.file-list {
  width: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
}

.summary-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 1.5rem;
  margin-bottom: 1rem;
  padding: 0.6rem 1rem;
  border-radius: 8px;
  background: #ebf8ff;
  border: 1px solid #bee3f8;
  color: #2a4365;
  font-size: 0.9rem;
}

.summary-selected {
  font-weight: 500;
}

.summary-muted {
  color: #718096;
  font-size: 0.8rem;
  font-weight: 400;
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

.table tr:hover {
  background: #f0f4f8;
}

.table tr.selected {
  background: #ebf8ff;
}

.table tr.video-row .name-cell {
  font-weight: 500;
}

.thumb-cell {
  width: 80px;
}

.thumbnail {
  width: 72px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #e2e8f0;
}

.no-thumb {
  color: #a0aec0;
}

.name-cell a {
  color: #2b6cb0;
  text-decoration: none;
}

.name-cell a:hover {
  text-decoration: underline;
}

.tag {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  border-radius: 9999px;
  background: #edf2f7;
  color: #718096;
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
}

.tag-new {
  background: #3182ce;
  color: white;
}

.tag-job-queued,
.tag-job-cancelled { background: #e2e8f0; color: #4a5568; }
.tag-job-fetching_metadata,
.tag-job-downloading,
.tag-job-uploading,
.tag-job-trashing_original { background: #bee3f8; color: #2a4365; }
.tag-job-transcoding,
.tag-job-skipped { background: #fefcbf; color: #744210; }
.tag-job-complete { background: #c6f6d5; color: #22543d; }
.tag-job-error { background: #fed7d7; color: #742a2a; }

.table tr.new-row {
  box-shadow: inset 3px 0 0 #3182ce;
}

.table tr.section-heading td {
  background: #edf2f7;
  font-weight: 600;
  color: #4a5568;
  font-size: 0.85rem;
}

.table tr.section-heading:hover {
  background: none;
}

.section-toggle {
  margin-left: 0.5rem;
  border: none;
  background: none;
  color: #2b6cb0;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0;
}

.section-toggle:hover {
  text-decoration: underline;
}

.section-hint {
  margin-left: 0.75rem;
  color: #718096;
  font-weight: 400;
  font-size: 0.8rem;
}

.section-processed .name-cell a,
.section-processed .size-cell,
.section-processed .saving-cell {
  opacity: 0.7;
}

.size-cell {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.saving-cell {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: #2c5282;
}

.resolution-cell {
  white-space: nowrap;
  color: #4a5568;
  font-size: 0.9rem;
}

.date-cell {
  white-space: nowrap;
  color: #718096;
}

.type-cell {
  color: #718096;
  font-size: 0.8rem;
}

.source-cell {
  white-space: nowrap;
  color: #4a5568;
}

.empty {
  padding: 2rem;
  text-align: center;
  color: #718096;
}

.load-more {
  text-align: center;
  margin-top: 1rem;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: background 0.15s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: #3182ce;
  color: white;
}

.btn-primary:not(:disabled):hover {
  background: #2c5282;
}

.btn-secondary {
  background: #e2e8f0;
  color: #2d3748;
}

.btn-secondary:not(:disabled):hover {
  background: #cbd5e0;
}
</style>
