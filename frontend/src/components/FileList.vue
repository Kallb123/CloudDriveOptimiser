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
      <button
        class="btn btn-primary"
        :disabled="selectedFiles.length === 0 || optimising"
        @click="$emit('optimise', selectedFiles)"
      >
        Optimise selected ({{ selectedFiles.length }})
      </button>
    </div>

    <div
      v-if="optimisableFiles.length > 0"
      class="summary-bar"
      title="Rough estimate based on resolution and duration"
    >
      <span>
        <strong>{{ overall.count }}</strong>
        optimisable {{ overall.count === 1 ? 'video' : 'videos' }}
        · {{ formatSize(overall.totalSize) }}
        · est. saving <strong>~{{ formatSize(overall.estimatedSaving) }}</strong>
        <span v-if="overall.unknownCount > 0" class="summary-muted">
          ({{ overall.unknownCount }} without enough info to estimate)
        </span>
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

    <table v-else class="table">
      <thead>
        <tr>
          <th><input type="checkbox" @change="toggleAll" :checked="allSelected" /></th>
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
      <tbody v-if="optimisableFiles.length > 0">
        <tr class="section-heading">
          <td :colspan="showThumbnails ? 9 : 8">Optimisable videos</td>
        </tr>
        <tr
          v-for="file in optimisableFiles"
          :key="file.id"
          :class="{ selected: selectedIds.includes(file.id), 'video-row': file.isVideo }"
        >
          <td>
            <input
              type="checkbox"
              :value="file.id"
              v-model="selectedIds"
              :disabled="!file.optimisable"
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
            <span v-if="file.isVideo && file.alreadyOptimised" class="tag">
              {{ file.notOptimisableReason || 'Already ≤720p' }}
            </span>
          </td>
          <td class="size-cell">{{file.source === "photos" ? "~" : ""}}{{ formatSize(file.size) }}</td>
          <td class="saving-cell" title="Rough estimate based on resolution and duration">{{ savingLabel(file) }}</td>
          <td class="resolution-cell">{{ fileResolution(file) }}</td>
          <td class="date-cell">{{ formatDate(file.createdTime) }}</td>
          <td class="source-cell">{{ sourceLabel(file.source) }}</td>
          <td class="type-cell">{{ shortMime(file.mimeType) }}</td>
        </tr>
      </tbody>
      <tbody v-if="otherFiles.length > 0">
        <tr class="section-heading">
          <td :colspan="showThumbnails ? 9 : 8">Not optimisable</td>
        </tr>
        <tr
          v-for="file in otherFiles"
          :key="file.id"
          :class="{ selected: selectedIds.includes(file.id), 'video-row': file.isVideo }"
        >
          <td>
            <input
              type="checkbox"
              :value="file.id"
              v-model="selectedIds"
              :disabled="!file.optimisable"
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
            <span v-if="file.isVideo && file.alreadyOptimised" class="tag">
              {{ file.notOptimisableReason || 'Already ≤720p' }}
            </span>
          </td>
          <td class="size-cell">{{file.source === "photos" ? "~" : ""}}{{ formatSize(file.size) }}</td>
          <td class="saving-cell" title="Rough estimate based on resolution and duration">{{ savingLabel(file) }}</td>
          <td class="resolution-cell">{{ fileResolution(file) }}</td>
          <td class="date-cell">{{ formatDate(file.createdTime) }}</td>
          <td class="source-cell">{{ sourceLabel(file.source) }}</td>
          <td class="type-cell">{{ shortMime(file.mimeType) }}</td>
        </tr>
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

const props = defineProps({
  files: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  optimising: { type: Boolean, default: false },
  nextPageToken: { type: String, default: null },
  // Default { targetHeight, crf } used for the estimates shown in the list.
  settings: { type: Object, default: () => ({ targetHeight: 720, crf: 28 }) },
})

const emit = defineEmits(['optimise', 'refresh', 'load-more'])

const showThumbnails = ref(false)
const filenameFilter = ref('')
const selectedIds = ref([])

const filteredFiles = computed(() => {
  const query = filenameFilter.value.trim().toLowerCase()
  if (!query) return props.files
  return props.files.filter((file) => file.name?.toLowerCase().includes(query))
})

const optimisableFiles = computed(() =>
  filteredFiles.value
    .filter((f) => f.optimisable)
    .sort((a, b) => b.size - a.size)
)
const otherFiles = computed(() =>
  filteredFiles.value
    .filter((f) => !f.optimisable)
    .sort((a, b) => b.size - a.size)
)
const selectedFiles = computed(() =>
  props.files.filter((file) => file.optimisable && selectedIds.value.includes(file.id))
)
const overall = computed(() => summariseEstimates(optimisableFiles.value, props.settings))
const selection = computed(() => summariseEstimates(selectedFiles.value, props.settings))
const allSelected = computed(
  () => optimisableFiles.value.length > 0 && optimisableFiles.value.every((f) => selectedIds.value.includes(f.id))
)

watch(
  () => props.files,
  (files) => {
    const availableIds = new Set(files.filter((file) => file.optimisable).map((file) => file.id))
    selectedIds.value = selectedIds.value.filter((id) => availableIds.has(id))
  },
  { deep: true }
)

function toggleAll(e) {
  if (e.target.checked) {
    selectedIds.value = optimisableFiles.value.map((f) => f.id)
  } else {
    selectedIds.value = []
  }
}

function checkboxTitle(file) {
  if (file.optimisable && file.source === 'photos') return 'Select Google Photos video for optimisation'
  if (file.optimisable) return 'Select Drive video for optimisation'
  return file.notOptimisableReason || 'Only video files can be optimised'
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
