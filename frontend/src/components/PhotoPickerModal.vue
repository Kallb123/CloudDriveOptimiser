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

defineExpose({ openPicker })

const isOpen = ref(props.modelValue)
const loading = ref(false)
const polling = ref(false)
const popupBlocked = ref(false)
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
    if (!isOpen.value) {
      cleanupPicker()
    }
  }
)

async function openPicker() {
  console.log('[PhotoPickerModal] openPicker() starting')
  try {
    loading.value = true
    polling.value = false
    popupBlocked.value = false
    error.value = null
    pickerCompleted.value = false
    selectedCount.value = 0

    if (!isOpen.value) {
      isOpen.value = true
      emit('update:modelValue', true)
      console.log('[PhotoPickerModal] modal opened')
    }

    popupWindow.value = window.open(
      '',
      'googlePhotosPicker',
      'width=900,height=700'
    )

    if (!popupWindow.value) {
      loading.value = false
      popupBlocked.value = true
      error.value = 'Popup blocked. Please open the picker in a new tab.'
      console.log('[PhotoPickerModal] popup blocked when opening placeholder window')
      return
    }

    try {
      if (popupWindow.value.document) {
        popupWindow.value.document.write('<p style="font-family: sans-serif; padding: 1rem;">Opening Google Photos Picker…</p>')
      }
    } catch (_err) {
      console.warn('[PhotoPickerModal] could not write to popup window placeholder:', _err)
    }

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
    console.log('[PhotoPickerModal] picker session created', { sessionId: sessionId.value, pickerUri: pickerUri.value })

    openPickerWindow()
    loading.value = false
  } catch (err) {
    loading.value = false
    error.value =
      err.response?.data?.error ||
      err.message ||
      'Failed to create Google Photos Picker session'
    console.error('[PhotoPickerModal] Picker creation error:', error.value, err)
  }
}

function getPickerUriWithAutoClose() {
  if (!pickerUri.value) return null
  return pickerUri.value.endsWith('/autoclose')
    ? pickerUri.value
    : `${pickerUri.value}/autoclose`
}

function openPickerWindow() {
  console.log('[PhotoPickerModal] openPickerWindow()', { pickerUri: pickerUri.value, existingPopup: !!popupWindow.value })
  if (!pickerUri.value) {
    error.value = 'Missing picker URI from backend.'
    console.error('[PhotoPickerModal] openPickerWindow() missing pickerUri')
    return
  }

  if (popupWindow.value && !popupWindow.value.closed) {
    try {
      popupWindow.value.location.href = pickerUri.value
      popupWindow.value.focus()
      console.log('[PhotoPickerModal] reused existing popup and navigated to pickerUri')
    } catch (_err) {
      popupBlocked.value = false
      error.value = 'Unable to load the picker in the opened popup. Please refresh and try again.'
      console.error('[PhotoPickerModal] openPickerWindow() navigation failed', _err)
      return
    }
  } else {
    popupWindow.value = window.open(
      getPickerUriWithAutoClose(),
      'googlePhotosPicker',
      'width=900,height=700'
    )

    if (!popupWindow.value) {
      popupBlocked.value = true
      error.value = 'Popup blocked. Please open the picker in a new tab.'
      console.error('[PhotoPickerModal] popup blocked when opening pickerUri')
      return
    }
    console.log('[PhotoPickerModal] opened new popup window for pickerUri')
  }

  polling.value = true
  pickerStartedDelayPolling()
}

function openPickerInTab() {
  console.log('[PhotoPickerModal] openPickerInTab()', { pickerUri: pickerUri.value })
  if (!pickerUri.value) {
    console.warn('[PhotoPickerModal] openPickerInTab() no pickerUri available')
    return
  }

  popupWindow.value = window.open(getPickerUriWithAutoClose(), '_blank')
  popupBlocked.value = false
  error.value = null
  if (popupWindow.value) {
    console.log('[PhotoPickerModal] opened picker in new tab')
    polling.value = true
    pickerStartedDelayPolling()
  } else {
    popupBlocked.value = true
    error.value = 'Popup blocked. Please open the picker in a new tab.'
    console.error('[PhotoPickerModal] openPickerInTab() blocked')
  }
}

function pickerStartedDelayPolling() {
  console.log('[PhotoPickerModal] pickerStartedDelayPolling()')
  stopStatusPolling()
  pollTimer = setTimeout(() => {
    if (!pickerCompleted.value) {
      console.log('[PhotoPickerModal] delayed polling started')
      startStatusPolling()
    }
  }, 5000)
}

function startStatusPolling() {
  console.log('[PhotoPickerModal] startStatusPolling()')
  stopStatusPolling()
  pollTimer = setInterval(checkPickerStatus, 2000)
  checkPickerStatus()
}

function stopStatusPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    console.log('[PhotoPickerModal] stopStatusPolling()')
  }
}

async function checkPickerStatus() {
  console.log('[PhotoPickerModal] checkPickerStatus()', {
    sessionId: sessionId.value,
    pickerCompleted: pickerCompleted.value,
  })
  console.log('[PhotoPickerModal] popupWindow state:', {
    exists: !!popupWindow.value
  })

  try {
    const { data: statusData } = await axios.post(
      '/api/drive/picker/status',
      { sessionId: sessionId.value },
      {
        headers: {
          'x-csrf-token': axios.defaults.headers.common['x-csrf-token'],
        },
      }
    )

    console.log('[PhotoPickerModal] picker status response', statusData)
    if (!statusData.done) {
      console.log('[PhotoPickerModal] picker not complete yet', { selectedCount: statusData.selectedCount })
      return
    }

    const { data: itemsData } = await axios.post(
      '/api/drive/picker/get-items',
      { sessionId: sessionId.value },
      {
        headers: {
          'x-csrf-token': axios.defaults.headers.common['x-csrf-token'],
        },
      }
    )

    const files = itemsData.files || []
    selectedCount.value = itemsData.selectedCount || files.length
    pickerCompleted.value = true
    polling.value = false
    stopStatusPolling()

    console.log('[PhotoPickerModal] picker complete, items selected', { selectedCount: selectedCount.value })
    console.log('[PhotoPickerModal] picker complete, items ', files)
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
    console.error('[PhotoPickerModal] Picker status error:', error.value, err)
  }
}

function retry() {
  console.log('[PhotoPickerModal] retry()')
  cleanupPicker()
  error.value = null
  pickerUri.value = null
  pickerCompleted.value = false
  selectedCount.value = 0
  openPicker()
}

function cleanupPicker() {
  console.log('[PhotoPickerModal] cleanupPicker()')
  stopStatusPolling()
  if (popupWindow.value && !popupWindow.value.closed) {
    popupWindow.value.close()
    console.log('[PhotoPickerModal] closed popup window')
  }
  popupWindow.value = null
}

function closeModal() {
  console.log('[PhotoPickerModal] closeModal()')
  isOpen.value = false
  cleanupPicker()
  pickerUri.value = null
  sessionId.value = null
  pickerCompleted.value = false
  error.value = null
  popupBlocked.value = false
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
