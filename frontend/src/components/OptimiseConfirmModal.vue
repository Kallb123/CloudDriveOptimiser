<!-- OptimiseConfirmModal.vue — "Review & confirm" step before optimising -->
<template>
  <div v-if="modelValue" class="modal-overlay" @click="close">
    <div
      class="modal-content"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      @click.stop
    >
      <div class="modal-header">
        <h3 id="confirm-title">Review &amp; confirm</h3>
        <button class="close-btn" @click="close" title="Close" aria-label="Close">×</button>
      </div>

      <div class="modal-body">
        <section class="settings">
          <div class="field-row">
            <label class="field">
              <span class="field-label">Resolution</span>
              <select v-model="targetHeight">
                <option v-for="h in resolutionOptions" :key="h" :value="h">{{ h }}p</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">Quality</span>
              <select v-model="crf">
                <option v-for="q in qualityChoices" :key="q.key" :value="q.crf">{{ q.label }}</option>
              </select>
            </label>
          </div>
          <p class="hint">Videos already smaller than the chosen resolution are not upscaled.</p>
        </section>

        <section class="summary" title="Rough estimate based on resolution and duration">
          <strong>{{ summary.count }}</strong> {{ summary.count === 1 ? 'video' : 'videos' }}
          · {{ formatSize(summary.totalSize) }} → ~{{ formatSize(summary.estimatedSize) }}
          <template v-if="replaceOriginals">
            · est. saving <strong>~{{ formatSize(summary.estimatedSaving) }}</strong>{{ savingPercent !== null ? ` (${savingPercent}%)` : '' }}
          </template>
          <template v-else>· download only, no space freed</template>
          <span v-if="summary.unknownCount > 0" class="muted">
            ({{ summary.unknownCount }} without enough info to estimate)
          </span>
        </section>

        <section class="what-happens">
          <h4>What will happen</h4>
          <ul>
            <li v-if="driveCount > 0">
              <template v-if="replaceOriginals">
                {{ driveCount }} Drive {{ plural(driveCount) }}: optimised copy uploaded to the same
                folder; original moved to the Drive bin (restorable for 30 days).
              </template>
              <template v-else>
                {{ driveCount }} Drive {{ plural(driveCount) }}: optimised copy available to download
                only; Drive is not changed.
              </template>
            </li>
            <li v-if="photosCount > 0">
              <template v-if="replaceOriginals">
                {{ photosCount }} Google Photos {{ plural(photosCount) }}: optimised copy added to the
                app's album. Google doesn't let apps delete photos, so remove the originals yourself
                afterwards.
              </template>
              <template v-else>
                {{ photosCount }} Google Photos {{ plural(photosCount) }}: optimised copy available to
                download only; Google Photos is not changed.
              </template>
            </li>
            <li>Originals are kept if the optimised copy isn't at least {{ minSaving }}% smaller.</li>
            <li v-if="config.maxConcurrentJobs">
              Videos are processed {{ config.maxConcurrentJobs }} at a time.
            </li>
          </ul>
        </section>

        <section class="toggle-group">
          <label class="toggle">
            <input
              type="checkbox"
              :checked="replaceOriginals"
              @change="$emit('update:replaceOriginals', $event.target.checked)"
            />
            Replace originals with optimised copies
          </label>
          <p class="hint">
            Drive originals are moved to the bin (restorable for 30 days). Google Photos copies are
            added alongside the original. Turn off to only download the optimised files.
          </p>
        </section>

        <details class="file-details">
          <summary>Files ({{ files.length }})</summary>
          <table class="file-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th title="Rough estimate based on resolution and duration">Est. size</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in files" :key="`${file.source}:${file.id}`">
                <td class="file-name" :title="file.name">{{ file.name }}</td>
                <td class="num">{{ file.source === 'photos' ? '~' : '' }}{{ formatSize(file.size) }}</td>
                <td class="num">{{ estimateLabel(file) }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" @click="close">Cancel</button>
        <button class="btn btn-primary" :disabled="files.length === 0" @click="confirm">
          Optimise {{ files.length }} {{ files.length === 1 ? 'video' : 'videos' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { formatSize, estimateOptimisedSize, summariseEstimates } from '../utils/estimate.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  files: { type: Array, default: () => [] },
  config: { type: Object, required: true },
  replaceOriginals: { type: Boolean, default: true },
})

const emit = defineEmits(['update:modelValue', 'update:replaceOriginals', 'confirm'])

const targetHeight = ref(props.config.targetHeight)
const crf = ref(props.config.crf)

const resolutionOptions = computed(() => {
  const options = [...(props.config.resolutionOptions || [])]
  if (!options.includes(props.config.targetHeight)) options.push(props.config.targetHeight)
  return options.sort((a, b) => a - b)
})

const qualityChoices = computed(() => {
  const options = [...(props.config.qualityOptions || [])]
  if (!options.some((q) => q.crf === props.config.crf)) {
    options.push({
      key: 'server-default',
      label: `Server default (CRF ${props.config.crf})`,
      crf: props.config.crf,
    })
  }
  return options
})

const settings = computed(() => ({
  targetHeight: targetHeight.value,
  crf: crf.value,
  minSavingPercent: props.config.minSavingPercent,
}))
const summary = computed(() => summariseEstimates(props.files, settings.value))
const savingPercent = computed(() =>
  summary.value.totalSize > 0
    ? Math.round((summary.value.estimatedSaving / summary.value.totalSize) * 100)
    : null
)
const driveCount = computed(() => props.files.filter((f) => f.source !== 'photos').length)
const photosCount = computed(() => props.files.filter((f) => f.source === 'photos').length)
const minSaving = computed(() => props.config.minSavingPercent ?? 10)

function plural(n) {
  return n === 1 ? 'video' : 'videos'
}

function estimateLabel(file) {
  const estimate = estimateOptimisedSize(file, settings.value)
  return estimate === null ? '—' : `~${formatSize(estimate)}`
}

function resetSettings() {
  targetHeight.value = props.config.targetHeight
  crf.value = props.config.crf
}

function close() {
  emit('update:modelValue', false)
}

function confirm() {
  if (props.files.length === 0) return
  const changed =
    targetHeight.value !== props.config.targetHeight || crf.value !== props.config.crf
  emit('confirm', { targetHeight: targetHeight.value, crf: crf.value, changed })
  emit('update:modelValue', false)
}

function onKeydown(event) {
  if (event.key === 'Escape' && props.modelValue) close()
}

// Reset to the server defaults every time the dialog opens.
watch(
  () => props.modelValue,
  (open) => {
    if (open) resetSettings()
  },
  { immediate: true }
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  width: 90%;
  max-width: 640px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.25rem;
  color: #2d3748;
}

.close-btn {
  background: none;
  border: none;
  font-size: 2rem;
  color: #718096;
  cursor: pointer;
  padding: 0;
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background 0.15s;
}

.close-btn:hover {
  background: #f7fafc;
  color: #2d3748;
}

.modal-body {
  flex: 1;
  padding: 1.25rem 1.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  color: #2d3748;
  font-size: 0.9rem;
}

.field-row {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex: 1;
  min-width: 160px;
}

.field-label {
  font-weight: 600;
  color: #4a5568;
}

.field select {
  padding: 0.45rem 0.6rem;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: white;
  font-size: 0.9rem;
  color: #2d3748;
}

.hint {
  margin-top: 0.4rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: #718096;
}

.summary {
  padding: 0.7rem 1rem;
  border-radius: 8px;
  background: #ebf8ff;
  border: 1px solid #bee3f8;
  color: #2a4365;
  line-height: 1.5;
}

.muted {
  color: #718096;
  font-size: 0.8rem;
}

.what-happens h4 {
  margin-bottom: 0.4rem;
  font-size: 0.95rem;
  color: #2d3748;
}

.what-happens ul {
  padding-left: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  line-height: 1.45;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  font-weight: 500;
}

.file-details summary {
  cursor: pointer;
  font-weight: 600;
  color: #2c5282;
}

.file-table {
  width: 100%;
  margin-top: 0.5rem;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.file-table th,
.file-table td {
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid #e2e8f0;
  text-align: left;
}

.file-table th {
  background: #f7fafc;
  color: #4a5568;
  font-weight: 600;
}

.file-table .num {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.file-name {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid #e2e8f0;
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
}

.btn {
  padding: 0.5rem 1.1rem;
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
