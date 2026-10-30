<!-- PhotoPickerModal.vue — handles Google Photos Picker flow -->
<template>
  <!-- No close on backdrop click: users click back here while the picker is open -->
  <div v-if="isOpen" class="modal-overlay">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Add videos from Google Photos</h3>
        <button class="close-btn" @click="closeModal" title="Close picker">×</button>
      </div>

      <div class="modal-body">
        <ol v-if="!error && !popupBlocked" class="steps">
          <li
            v-for="(step, index) in STEPS"
            :key="step.key"
            :class="stepClass(index)"
          >
            <span class="step-marker">{{ index < currentStepIndex ? '✓' : index + 1 }}</span>
            <span>{{ step.label }}</span>
          </li>
        </ol>

        <!-- Creating the picker session -->
        <div v-if="phase === 'opening'" class="loading-state">
          <div class="spinner"></div>
          <p>Opening Google Photos in a new window…</p>
        </div>

        <!-- User is choosing items in the popup -->
        <div v-else-if="phase === 'selecting'" class="loading-state">
          <div class="spinner"></div>
          <p class="phase-title">Choose your videos in the Google Photos window, then click <strong>Done</strong>.</p>
          <p class="phase-hint">
            This page carries on by itself once you click Done.
            <template v-if="elapsedSeconds >= 5">Waiting {{ formatElapsed(elapsedSeconds) }}.</template>
          </p>
          <p v-if="pickerExpiresAt" class="phase-hint">
            The selection window expires at {{ formatTime(pickerExpiresAt) }}.
          </p>
          <button class="btn btn-secondary" @click="reopenPickerWindow">
            Can't see it? Reopen Google Photos
          </button>
        </div>

        <!-- Listing the selected items -->
        <div v-else-if="phase === 'fetching'" class="loading-state">
          <div class="spinner"></div>
          <p class="phase-title">Getting your selection from Google Photos…</p>
        </div>

        <!-- Looking up each video's size -->
        <div v-else-if="phase === 'measuring'" class="loading-state">
          <p class="phase-title">
            Checking video sizes: {{ measuredCount }} of {{ measureTotal }}
          </p>
          <div
            class="progress-bar"
            role="progressbar"
            :aria-valuenow="measuredCount"
            aria-valuemin="0"
            :aria-valuemax="measureTotal"
          >
            <div class="progress-fill" :style="{ width: `${measurePercent}%` }"></div>
          </div>
          <p class="phase-hint">
            Google Photos doesn't report file sizes, so each video is checked once.
            Skipping leaves the sizes and savings estimates blank.
          </p>
          <button class="btn btn-secondary" @click="skipMeasuring">
            Skip and add now
          </button>
        </div>

        <!-- Error state -->
        <div v-if="error" class="error-state">
          <p class="error-message">{{ error }}</p>
          <button class="btn btn-secondary" @click="retry">
            Start again
          </button>
        </div>

        <!-- Fallback open tab button -->
        <div v-if="popupBlocked" class="blocked-state">
          <p>Your browser blocked the popup. Please open the picker in a new tab.</p>
          <button class="btn btn-primary" :disabled="!pickerUri" @click="openPickerInTab">
            Open Picker in New Tab
          </button>
        </div>

      </div>

      <div class="modal-footer">
        <button
          class="btn btn-secondary"
          @click="closeModal"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import axios from 'axios'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'items-selected'])

defineExpose({ openPicker })

const STEPS = [
  { key: 'selecting', label: 'Choose videos in Google Photos' },
  { key: 'fetching', label: 'Fetch your selection' },
  { key: 'measuring', label: 'Check video sizes' },
]
const DEFAULT_POLL_MS = 2000
const MIN_POLL_MS = 1000
const MAX_POLL_MS = 5000
// Must match MAX_SIZE_IDS_PER_REQUEST on the backend.
const SIZE_BATCH = 10

const isOpen = ref(props.modelValue)
// '' | 'opening' | 'selecting' | 'fetching' | 'measuring'
const phase = ref('')
const popupBlocked = ref(false)
const error = ref(null)
const pickerUri = ref(null)
const sessionId = ref(null)
const pickerExpiresAt = ref(null)
const popupWindow = ref(null)
const elapsedSeconds = ref(0)
const measuredCount = ref(0)
const measureTotal = ref(0)
let pollTimer = null
let elapsedTimer = null
// Bumped on every open/close so callbacks from an abandoned run are ignored.
let runId = 0
// Set while measuring; resolving it stops waiting for the remaining sizes.
let skipMeasuringNow = null

const currentStepIndex = computed(() => {
  if (phase.value === 'opening') return 0
  return Math.max(0, STEPS.findIndex((step) => step.key === phase.value))
})

const measurePercent = computed(() =>
  measureTotal.value > 0 ? Math.round((measuredCount.value / measureTotal.value) * 100) : 0
)

// Watch for external changes to the modal value
watch(
  () => props.modelValue,
  (newValue) => {
    isOpen.value = newValue
    if (!isOpen.value) {
      cleanupPicker()
    }
  }
)

function stepClass(index) {
  if (index < currentStepIndex.value) return 'step-done'
  if (index === currentStepIndex.value) return 'step-active'
  return ''
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function csrfHeaders() {
  return { 'x-csrf-token': axios.defaults.headers.common['x-csrf-token'] }
}

function resetState() {
  phase.value = ''
  popupBlocked.value = false
  error.value = null
  pickerUri.value = null
  sessionId.value = null
  pickerExpiresAt.value = null
  measuredCount.value = 0
  measureTotal.value = 0
  skipMeasuringNow = null
}

function fail(message, err) {
  stopTimers()
  phase.value = ''
  error.value = err?.response?.data?.error || message
  console.error('[PhotoPickerModal]', error.value, err)
}

async function openPicker() {
  cleanupPicker()
  resetState()
  const run = ++runId
  phase.value = 'opening'

  if (!isOpen.value) {
    isOpen.value = true
    emit('update:modelValue', true)
  }

  // Open the window synchronously (inside the click) so it isn't blocked,
  // then point it at the picker once the session exists.
  popupWindow.value = window.open('', 'googlePhotosPicker', 'width=900,height=700')
  if (!popupWindow.value) {
    phase.value = ''
    popupBlocked.value = true
  } else {
    try {
      popupWindow.value.document.write('<p style="font-family: sans-serif; padding: 1rem;">Opening Google Photos Picker…</p>')
    } catch (_err) {
      // Cross-origin or already navigated; harmless.
    }
  }

  try {
    const { data } = await axios.post('/api/drive/picker/create-session', {}, { headers: csrfHeaders() })
    if (run !== runId) return
    pickerUri.value = data.pickerUri
    sessionId.value = data.sessionId
  } catch (err) {
    if (run !== runId) return
    fail('Failed to create Google Photos Picker session', err)
    return
  }

  if (popupBlocked.value) return
  if (!navigatePopup()) return
  startSelecting(run)
}

function getPickerUriWithAutoClose() {
  if (!pickerUri.value) return null
  return pickerUri.value.endsWith('/autoclose')
    ? pickerUri.value
    : `${pickerUri.value}/autoclose`
}

// Points the already-open popup at the picker, opening a new one if needed.
function navigatePopup() {
  if (popupWindow.value && !popupWindow.value.closed) {
    try {
      popupWindow.value.location.href = getPickerUriWithAutoClose()
      popupWindow.value.focus()
      return true
    } catch (err) {
      fail('Unable to load the picker in the opened popup. Please try again.', err)
      return false
    }
  }
  popupWindow.value = window.open(getPickerUriWithAutoClose(), 'googlePhotosPicker', 'width=900,height=700')
  if (!popupWindow.value) {
    phase.value = ''
    popupBlocked.value = true
    return false
  }
  return true
}

function reopenPickerWindow() {
  if (!pickerUri.value) return
  if (popupWindow.value && !popupWindow.value.closed) {
    popupWindow.value.focus()
    return
  }
  // The picker page may sever our handle to the popup (it then reads as
  // closed), so open by name: browsers reuse the window where they can.
  popupWindow.value = window.open(getPickerUriWithAutoClose(), 'googlePhotosPicker', 'width=900,height=700')
  if (!popupWindow.value) {
    popupBlocked.value = true
  }
}

function openPickerInTab() {
  if (!pickerUri.value) return
  popupWindow.value = window.open(getPickerUriWithAutoClose(), '_blank')
  if (!popupWindow.value) return
  popupBlocked.value = false
  error.value = null
  startSelecting(runId)
}

function startSelecting(run) {
  phase.value = 'selecting'
  elapsedSeconds.value = 0
  stopTimers()
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value++
  }, 1000)
  schedulePoll(run, DEFAULT_POLL_MS)
}

function schedulePoll(run, delay) {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => {
    pollTimer = null
    if (run === runId) checkPickerStatus(run)
  }, delay)
}

function stopTimers() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

async function checkPickerStatus(run) {
  let statusData
  try {
    ;({ data: statusData } = await axios.post(
      '/api/drive/picker/status',
      { sessionId: sessionId.value },
      { headers: csrfHeaders() }
    ))
  } catch (err) {
    if (run !== runId) return
    fail('Lost contact with the Google Photos picker. It may have expired — please start again.', err)
    return
  }
  if (run !== runId) return

  if (statusData.expireTime) pickerExpiresAt.value = new Date(statusData.expireTime)

  if (!statusData.done) {
    const interval = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, statusData.pollIntervalMs || DEFAULT_POLL_MS))
    schedulePoll(run, interval)
    return
  }

  stopTimers()
  await collectSelection(run)
}

async function collectSelection(run) {
  phase.value = 'fetching'
  let files
  try {
    const { data } = await axios.post(
      '/api/drive/picker/get-items',
      { sessionId: sessionId.value },
      { headers: csrfHeaders() }
    )
    files = data.files || []
  } catch (err) {
    if (run !== runId) return
    fail('Failed to fetch your selection from Google Photos', err)
    return
  }
  if (run !== runId) return

  const skipped = new Promise((resolve) => {
    skipMeasuringNow = resolve
  })
  await Promise.race([measureVideoSizes(run, files), skipped])
  skipMeasuringNow = null
  if (run !== runId) return

  emit('items-selected', files)
  closeModal()
}

// Fills in file.size for picked videos that can be optimised (the others only
// need listing), a batch at a time so progress shows. A failed batch leaves
// those sizes unknown rather than failing the pick.
async function measureVideoSizes(run, files) {
  const videos = files.filter((file) => file.optimisable && file.size == null)
  if (videos.length === 0) return

  phase.value = 'measuring'
  measureTotal.value = videos.length
  measuredCount.value = 0

  for (let i = 0; i < videos.length; i += SIZE_BATCH) {
    if (run !== runId || !skipMeasuringNow) return
    const batch = videos.slice(i, i + SIZE_BATCH)
    try {
      const { data } = await axios.post(
        '/api/drive/picker/sizes',
        { ids: batch.map((file) => file.id) },
        { headers: csrfHeaders() }
      )
      // Skipped meanwhile: the files have already been handed over.
      if (run !== runId || !skipMeasuringNow) return
      for (const file of batch) {
        const size = data.sizes?.[file.id]
        if (typeof size === 'number' && size > 0) file.size = size
      }
    } catch (err) {
      console.warn('[PhotoPickerModal] could not read video sizes', err?.message || err)
    }
    if (run !== runId) return
    measuredCount.value = Math.min(videos.length, i + batch.length)
  }
}

function skipMeasuring() {
  skipMeasuringNow?.()
}

function retry() {
  openPicker()
}

function cleanupPicker() {
  runId++
  stopTimers()
  if (popupWindow.value && !popupWindow.value.closed) {
    popupWindow.value.close()
  }
  popupWindow.value = null
}

function closeModal() {
  isOpen.value = false
  cleanupPicker()
  resetState()
  emit('update:modelValue', false)
}

onUnmounted(() => {
  cleanupPicker()
})
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
  max-width: 600px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 1.5rem;
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
  padding: 1.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}

.picker-frame {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 8px;
  min-height: 400px;
}

.loading-state,
.error-state,
.no-selection,
.selection-summary {
  text-align: center;
  padding: 2rem;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #e2e8f0;
  border-top-color: #3182ce;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-state {
  color: #c53030;
}

.error-message {
  margin-bottom: 1rem;
  font-size: 0.95rem;
}

.no-selection,
.selection-summary {
  color: #718096;
}

.selection-summary {
  color: #2d3748;
  font-size: 1.1rem;
}

.steps {
  list-style: none;
  display: flex;
  gap: 0.5rem 1.25rem;
  flex-wrap: wrap;
  justify-content: center;
  margin-bottom: 1rem;
  font-size: 0.85rem;
  color: #a0aec0;
}

.steps li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.step-marker {
  width: 1.4rem;
  height: 1.4rem;
  border-radius: 50%;
  border: 2px solid currentColor;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
}

.steps .step-active {
  color: #2b6cb0;
  font-weight: 600;
}

.steps .step-done {
  color: #38a169;
}

.phase-title {
  color: #2d3748;
  font-size: 1rem;
  max-width: 28rem;
}

.phase-hint {
  color: #718096;
  font-size: 0.85rem;
  max-width: 28rem;
}

.progress-bar {
  width: 100%;
  max-width: 24rem;
  height: 10px;
  background: #e2e8f0;
  border-radius: 9999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #3182ce;
  transition: width 0.3s ease;
}

.blocked-state {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.modal-footer {
  padding: 1.5rem;
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
