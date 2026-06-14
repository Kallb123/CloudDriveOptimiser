<!-- PhotoPickerModal.vue — handles Google Photos Picker flow -->
<template>
  <div v-if="isOpen" class="modal-overlay" @click="closeModal">
    <div class="modal-content" @click.stop>
      <div class="modal-header">
        <h3>Select Videos from Google Photos</h3>
        <button class="close-btn" @click="closeModal" title="Close picker">×</button>
      </div>

      <div class="modal-body">
        <!-- Loading / polling state -->
        <div v-if="loading" class="loading-state">
          <div class="spinner"></div>
          <p>Opening Google Photos Picker in a secure popup...</p>
          <p>Please complete your selection in the popup window.</p>
        </div>

        <!-- Polling status -->
        <div v-else-if="polling" class="loading-state">
          <div class="spinner"></div>
          <p>Waiting for Google Photos selection to complete...</p>
          <p v-if="popupClosed">It looks like the popup was closed before completion.</p>
        </div>

        <!-- Error state -->
        <div v-if="error" class="error-state">
          <p class="error-message">{{ error }}</p>
          <button class="btn btn-secondary" @click="retry">
            Retry
          </button>
        </div>

        <!-- Fallback open tab button -->
        <div v-if="popupBlocked && !loading && !polling" class="blocked-state">
          <p>Your browser blocked the popup. Please open the picker in a new tab.</p>
          <button class="btn btn-primary" @click="openPickerInTab">
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
import { ref, watch, onUnmounted } from 'vue'
import axios from 'axios'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'items-selected'])

const isOpen = ref(props.modelValue)
const loading = ref(false)
const polling = ref(false)
const popupBlocked = ref(false)
const popupClosed = ref(false)
const error = ref(null)
const pickerUri = ref(null)
const sessionId = ref(null)
const pickerCompleted = ref(false)
const selectedCount = ref(0)
const popupWindow = ref(null)
let pollTimer = null

// Watch for external changes to the modal value
watch(
  () => props.modelValue,
  (newValue) => {
    isOpen.value = newValue
    if (isOpen.value) {
      openPicker()
    } else {
      cleanupPicker()
    }
  }
)

async function openPicker() {
  try {
    loading.value = true
    polling.value = false
    popupBlocked.value = false
    popupClosed.value = false
    error.value = null
    pickerCompleted.value = false
    selectedCount.value = 0

    const { data } = await axios.post(
      '/api/drive/picker/create-session',
      {},
      {
        headers: {
          'x-csrf-token': axios.defaults.headers.common['x-csrf-token'],
        },
      }
    )

    pickerUri.value = data.pickerUri
    sessionId.value = data.sessionId

    loading.value = false

    openPickerWindow()
  } catch (err) {
    loading.value = false
    error.value =
      err.response?.data?.error ||
      err.message ||
      'Failed to create Google Photos Picker session'
    console.error('Picker creation error:', error.value)
  }
}

function openPickerWindow() {
  if (!pickerUri.value) {
    error.value = 'Missing picker URI from backend.'
    return
  }

  popupWindow.value = window.open(
    pickerUri.value,
    'googlePhotosPicker',
    'width=900,height=700,noopener,noreferrer'
  )

  if (!popupWindow.value) {
    popupBlocked.value = true
    error.value = 'Popup blocked. Please open the picker in a new tab.'
    return
  }

  polling.value = true
  startStatusPolling()
}

function openPickerInTab() {
  if (!pickerUri.value) return
  popupWindow.value = window.open(pickerUri.value, '_blank', 'noopener,noreferrer')
  popupBlocked.value = false
  error.value = null
  if (popupWindow.value) {
    polling.value = true
    startStatusPolling()
  }
}

function startStatusPolling() {
  stopStatusPolling()
  pollTimer = setInterval(checkPickerStatus, 2000)
  checkPickerStatus()
}

function stopStatusPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function checkPickerStatus() {
  if (popupWindow.value && popupWindow.value.closed) {
    popupClosed.value = true
  }

  if (popupClosed.value && !pickerCompleted.value) {
    stopStatusPolling()
    polling.value = false
    error.value = 'Picker popup closed before selection completed.'
    return
  }

  try {
    const { data } = await axios.post(
      '/api/drive/picker/status',
      { sessionId: sessionId.value },
      {
        headers: {
          'x-csrf-token': axios.defaults.headers.common['x-csrf-token'],
        },
      }
    )

    if (!data.done) {
      return
    }

    const files = data.files || []
    selectedCount.value = data.selectedCount || files.length
    pickerCompleted.value = true
    polling.value = false
    stopStatusPolling()

    emit('items-selected', files)
    closeModal()
  } catch (err) {
    stopStatusPolling()
    polling.value = false
    loading.value = false
    error.value =
      err.response?.data?.error ||
      err.message ||
      'Failed to poll Google Photos Picker status'
    console.error('Picker status error:', error.value)
  }
}

function retry() {
  cleanupPicker()
  error.value = null
  pickerUri.value = null
  pickerCompleted.value = false
  selectedCount.value = 0
  openPicker()
}

function cleanupPicker() {
  stopStatusPolling()
  if (popupWindow.value && !popupWindow.value.closed) {
    popupWindow.value.close()
  }
  popupWindow.value = null
}

function closeModal() {
  isOpen.value = false
  cleanupPicker()
  pickerUri.value = null
  sessionId.value = null
  pickerCompleted.value = false
  error.value = null
  popupBlocked.value = false
  popupClosed.value = false
  selectedCount.value = 0
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
