<!-- FileList.vue — displays analysed files sorted by size -->
<template>
  <div class="file-list">
    <div class="toolbar">
      <label class="toggle">
        <input type="checkbox" v-model="showThumbnails" />
        Show thumbnails
      </label>
      <button
        class="btn btn-primary"
        :disabled="selectedItems.length === 0 || optimising"
        @click="$emit('optimise', selectedItems)"
      >
        Optimise selected ({{ selectedItems.length }})
      </button>
      <button class="btn btn-secondary" @click="$emit('refresh')">
        Refresh
      </button>
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
          <th>Size</th>
          <th>Uploaded</th>
          <th>Source</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="file in files"
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
          </td>
          <td class="size-cell">{{ formatSize(file.size) }}</td>
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

const props = defineProps({
  files: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  optimising: { type: Boolean, default: false },
  nextPageToken: { type: String, default: null },
})

const emit = defineEmits(['optimise', 'refresh', 'load-more'])

const showThumbnails = ref(false)
const selectedIds = ref([])

const videoFiles = computed(() => props.files.filter((f) => f.optimisable))
const selectedItems = computed(() =>
  props.files
    .filter((file) => selectedIds.value.includes(file.id))
    .map((file) => {
      const item = { id: file.id, source: file.source || 'drive' }
      if (file.source === 'photos' && file.mediaItem) {
        item.mediaItem = file.mediaItem
      }
      return item
    })
)
const allSelected = computed(
  () => videoFiles.value.length > 0 && videoFiles.value.every((f) => selectedIds.value.includes(f.id))
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
    selectedIds.value = videoFiles.value.map((f) => f.id)
  } else {
    selectedIds.value = []
  }
}

function checkboxTitle(file) {
  if (file.optimisable && file.source === 'photos') return 'Select Google Photos video for optimisation'
  if (file.optimisable) return 'Select Drive video for optimisation'
  return 'Only video files can be optimised'
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

.size-cell {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
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
