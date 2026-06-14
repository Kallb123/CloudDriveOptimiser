<!-- PhotoPickerModal.vue — handles Google Photos Picker flow -->
<template>
  <div v-if="isOpen" class="modal-overlay" @click="closeModal">
    <div class="modal-content" @click.stop>
      <div class="modal-header">
        <h3>Select Videos from Google Photos</h3>
        <button class="close-btn" @click="closeModal" title="Close picker">×</button>
      </div>

      <div class="modal-body">
        <!-- Loading state -->
        <div v-if="loading" class="loading-state">
          <div class="spinner"></div>
          <p>Opening Google Photos Picker...</p>
        </div>

        <!-- Error state -->
        <div v-if="error" class="error-state">
          <p class="error-message">{{ error }}</p>
          <button class="btn btn-secondary" @click="retry">
            Retry
          </button>
        </div>

        <!-- Picker iframe -->
        <iframe
          v-if="pickerUri && !loading && !error"
          :src="pickerUri"
          class="picker-frame"
          sandbox="allow-same-origin allow-scripts"
          title="Google Photos Picker"
        />

        <!-- No items selected message -->
        <div v-if="pickerCompleted && selectedCount === 0" class="no-selection">
          <p>No items selected. Please try again.</p>
        </div>

        <!-- Summary of selected items -->
        <div v-if="pickerCompleted && selectedCount > 0" class="selection-summary">
          <p>Selected <strong>{{ selectedCount }}</strong> item(s) from Google Photos.</p>
        </div>
      </div>

      <div class="modal-footer">
        <button
          class="btn btn-secondary"
          @click="closeModal"
        >
          {{ pickerCompleted ? 'Close' : 'Cancel' }}
        </button>
        <button
          v-if="pickerCompleted && selectedCount > 0"
          class="btn btn-primary"
          @click="confirmSelection"
        >
          Add to Library
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import axios from 'axios'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'items-selected'])

const isOpen = ref(props.modelValue)
const loading = ref(false)
const error = ref(null)
const pickerUri = ref(null)
const sessionId = ref(null)
const pickerCompleted = ref(false)
const selectedCount = ref(0)

// Watch for external changes to the modal value
const unwatch = () => {}
onMounted(() => {
  const watcher = () => {
    isOpen.value = props.modelValue
    if (isOpen.value) {
      openPicker()
    }
  }
  watcher()
})

async function openPicker() {
  try {
    loading.value = true
    error.value = null
    pickerCompleted.value = false
    selectedCount.value = 0

    // Call backend to create picker session
    const { data } = await axios.post(
      '/api/drive/picker/create-session',
      {},
      { withCredentials: true }
    )

    pickerUri.value = data.pickerUri
    sessionId.value = data.sessionId

    // Listen for picker completion message
    setupPostMessageListener()

    loading.value = false
  } catch (err) {
    loading.value = false
    error.value =
      err.response?.data?.error ||
      err.message ||
      'Failed to create Google Photos Picker session'
    console.error('Picker creation error:', error.value)
  }
}

function setupPostMessageListener() {
  function handleMessage(event) {
    // Verify the message origin in production
    // event.origin check would be needed with actual Google domain

    if (event.data?.type === 'SELECTION_COMPLETE') {
      console.log('Picker selection completed')
      pickerCompleted.value = true
      selectedCount.value = event.data?.count || 0
      window.removeEventListener('message', handleMessage)
    }
  }

  window.addEventListener('message', handleMessage)
}

async function confirmSelection() {
  try {
    loading.value = true
    error.value = null

    // Call backend to get selected items using sessionId
    const { data } = await axios.post(
      '/api/drive/picker/get-items',
      { sessionId: sessionId.value },
      { withCredentials: true }
    )

    const files = data.files || []
    console.log('Picker items retrieved:', files.length)

    // Emit selected items to parent
    emit('items-selected', files)

    // Close the modal
    closeModal()
  } catch (err) {
    error.value =
      err.response?.data?.error ||
      err.message ||
      'Failed to retrieve selected items'
    console.error('Get items error:', error.value)
    loading.value = false
  }
}

function retry() {
  error.value = null
  pickerUri.value = null
  pickerCompleted.value = false
  openPicker()
}

function closeModal() {
  isOpen.value = false
  pickerUri.value = null
  sessionId.value = null
  pickerCompleted.value = false
  error.value = null
  emit('update:modelValue', false)
}

onUnmounted(() => {
  if (unwatch) unwatch()
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
