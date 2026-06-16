<template>
  <div id="app">
    <!-- Header -->
    <header class="header">
      <div class="brand">
        <svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/>
        </svg>
        <span>CloudDriveOptimiser</span>
      </div>

      <div class="user-area" v-if="user">
        <img v-if="user.picture" :src="user.picture" :alt="user.name" class="avatar" />
        <span class="user-name">{{ user.name }}</span>
        <button class="btn btn-sm btn-secondary" @click="logout">Sign out</button>
      </div>
    </header>

    <!-- Main content -->
    <main class="main">
      <!-- Not authenticated -->
      <div v-if="!authenticated" class="login-card">
        <h1>CloudDriveOptimiser</h1>
        <p>Analyse your Google Drive and Google Photos library, find large videos, and optimise them to save space.</p>
        <div v-if="authError" class="alert alert-error">
          Authentication failed. Please try again.
        </div>
        <a href="/auth/google" class="btn btn-google">
          <svg class="google-icon" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Sign in with Google
        </a>
      </div>

      <!-- Authenticated -->
      <div v-else class="dashboard">
        <div class="dashboard-header">
          <h2>Your Drive + Photos — Largest Media</h2>
          <div class="header-buttons">
            <button
              class="btn btn-primary"
              :disabled="loading"
              @click="analyseFiles"
            >
              {{ loading ? 'Analysing…' : analysed ? 'Re-analyse' : 'Analyse library' }}
            </button>
            <button
              class="btn btn-primary"
              @click="openPhotoPicker"
            >
              Select Videos
            </button>
          </div>
        </div>

        <div v-if="error" class="alert alert-error">{{ error }}</div>

        <FileList
          v-if="analysed"
          :files="files"
          :loading="loading"
          :optimising="optimising"
          :nextPageToken="nextPageToken"
          @optimise="startOptimise"
          @refresh="analyseFiles"
          @load-more="loadMore"
        />

        <div ref="jobStatusAnchor">
          <JobStatus :jobs="jobList" @clear="clearOptimisationHistory" />
        </div>
      </div>

      <!-- Photo Picker Modal -->
      <PhotoPickerModal
        ref="photoPickerRef"
        v-model="pickerModalOpen"
        @items-selected="handlePhotosSelected"
      />
    </main>

    <!-- Footer -->
    <footer class="app-footer">v{{ appVersion }}</footer>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import axios from 'axios'
import FileList from './components/FileList.vue'
import JobStatus from './components/JobStatus.vue'
import PhotoPickerModal from './components/PhotoPickerModal.vue'


const appVersion = __APP_VERSION__;

const authenticated = ref(false)
const user = ref(null)
const files = ref([])
const loading = ref(false)
const optimising = ref(false)
const analysed = ref(false)
const error = ref(null)
const nextPageToken = ref(null)
const jobList = ref([])
const authError = ref(false)
const pickerModalOpen = ref(false)
const photoPickerRef = ref(null)
const jobStatusAnchor = ref(null)

const PHOTO_PICKER_STORAGE_KEY_PREFIX = 'cdo:photo-picker-files'
const PHOTO_PICKER_STORAGE_TTL_MS = 60 * 60 * 1000 // 60 minutes

let pollTimer = null
let pollingActive = false

function getPhotoStorageKey() {
  return user.value?.id
    ? `${PHOTO_PICKER_STORAGE_KEY_PREFIX}:${user.value.id}`
    : PHOTO_PICKER_STORAGE_KEY_PREFIX
}

function loadPersistedPhotoFiles() {
  if (!user.value?.id) return []
  try {
    const raw = localStorage.getItem(getPhotoStorageKey())
    if (!raw) return []

    const parsed = JSON.parse(raw)
    const photoFiles = Array.isArray(parsed.items)
      ? parsed.items
      : Array.isArray(parsed)
      ? parsed
      : []
    const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now()

    if (!Array.isArray(photoFiles)) {
      clearPersistedPhotoFiles()
      return []
    }

    if (Date.now() - savedAt > PHOTO_PICKER_STORAGE_TTL_MS) {
      clearPersistedPhotoFiles()
      return []
    }

    return photoFiles
  } catch {
    clearPersistedPhotoFiles()
    return []
  }
}

function savePersistedPhotoFiles() {
  if (!user.value?.id) return
  const photoFiles = files.value.filter((file) => file.source === 'photos')
  const payload = {
    savedAt: Date.now(),
    items: photoFiles,
  }
  localStorage.setItem(getPhotoStorageKey(), JSON.stringify(payload))
}

function clearPersistedPhotoFiles() {
  if (user.value?.id) {
    localStorage.removeItem(getPhotoStorageKey())
  }
}

function isPersistedPhotoThumbnailAccessible(photo) {
  const url = photo.thumbnailLink || photo.baseUrl
  if (!url) return true

  return fetch(url, {
    method: 'GET',
    cache: 'no-store',
    mode: 'cors',
  })
    .then((response) => {
      return response.status !== 401 && response.status !== 403
    })
    .catch(() => true)
}

function removePersistedPhotoById(photoId) {
  if (!user.value?.id || !photoId) return false

  const raw = localStorage.getItem(getPhotoStorageKey())
  if (!raw) return false

  try {
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed.items)
      ? parsed.items
      : Array.isArray(parsed)
      ? parsed
      : []

    const filtered = items.filter((file) => {
      if (!file) return true
      if (file.id === photoId) return false
      if (file.mediaItem?.id === photoId) return false
      return true
    })

    if (filtered.length === items.length) return false

    if (filtered.length === 0) {
      localStorage.removeItem(getPhotoStorageKey())
    } else {
      localStorage.setItem(
        getPhotoStorageKey(),
        JSON.stringify({ savedAt: parsed.savedAt || Date.now(), items: filtered })
      )
    }

    files.value = files.value.filter(
      (file) => !(file.source === 'photos' && (file.id === photoId || file.mediaItem?.id === photoId))
    )

    return true
  } catch {
    return false
  }
}

function isAuthorisationError(err) {
  const status = err?.response?.status
  const message = String(err?.response?.data?.error || err?.message || '').toLowerCase()
  return (
    status === 401 || status === 403 ||
    /auth|authorisation|authorization|expired|permission/.test(message)
  )
}

function isAuthorisationErrorString(message) {
  if (!message) return false
  return /auth|authorisation|authorization|expired|permission/.test(String(message).toLowerCase())
}

async function validatePersistedPhotos(photoFiles) {
  if (!Array.isArray(photoFiles) || photoFiles.length === 0) return

  await Promise.all(
    photoFiles.map(async (file) => {
      const photoId = file.id || file.mediaItem?.id
      if (!photoId) return

      const accessible = await isPersistedPhotoThumbnailAccessible(file)
      if (!accessible) {
        removePersistedPhotoById(photoId)
      }
    })
  )
}

function handlePersistedPhotoJobErrors(jobList) {
  if (!Array.isArray(jobList)) return

  for (const job of jobList) {
    if (
      job.source === 'photos' &&
      job.status === 'error' &&
      isAuthorisationErrorString(job.error)
    ) {
      removePersistedPhotoById(job.fileId)
    }
  }
}

function mergeFiles(driveFiles, photoFiles) {
  const fileMap = new Map()
  ;[...photoFiles, ...driveFiles].forEach((file) => {
    const key = `${file.source}:${file.id}`
    if (!fileMap.has(key)) {
      fileMap.set(key, file)
    }
  })
  return Array.from(fileMap.values()).sort((a, b) => (b.size || 0) - (a.size || 0))
}

// ---- Auth ----

async function checkAuth() {
  try {
    const { data } = await axios.get('/auth/status', { withCredentials: true })
    authenticated.value = data.authenticated
    user.value = data.user || null
  } catch {
    authenticated.value = false
    user.value = null
  }
}

async function logout() {
  await axios.post('/auth/logout', {}, { withCredentials: true })
  clearPersistedPhotoFiles()
  authenticated.value = false
  user.value = null
  files.value = []
  analysed.value = false
  jobList.value = []
  stopPolling()
}

// ---- Drive files ----

async function analyseFiles() {
  error.value = null
  loading.value = true
  nextPageToken.value = null
  analysed.value = true
  try {
    const { data } = await axios.get('/api/drive/files', { withCredentials: true })
    const persistedPhotos = loadPersistedPhotoFiles()
    files.value = mergeFiles(data.files, persistedPhotos)
    await validatePersistedPhotos(persistedPhotos)
    nextPageToken.value = data.nextPageToken
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to fetch files'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextPageToken.value || loading.value) return
  loading.value = true
  try {
    const { data } = await axios.get('/api/drive/files', {
      params: { pageToken: nextPageToken.value },
      withCredentials: true,
    })
    files.value = mergeFiles([...files.value, ...data.files], loadPersistedPhotoFiles())
    nextPageToken.value = data.nextPageToken
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to load more files'
  } finally {
    loading.value = false
  }
}

// ---- Photo Picker ----

function openPhotoPicker() {
  error.value = null
  photoPickerRef.value?.openPicker()
}

function handlePhotosSelected(photoFiles) {
  // Add selected photo files to the file list and persist them
  files.value = mergeFiles([...files.value, ...photoFiles], [])
  savePersistedPhotoFiles()
  console.log('Added', photoFiles.length, 'photos from picker to file list')
}

// ---- Optimisation ----

async function startOptimise(items) {
  error.value = null
  optimising.value = true
  try {
    const { data } = await axios.post(
      '/api/optimise/start',
      { items },
      { withCredentials: true }
    )
    // Seed job list entries
    const newJobs = data.jobs.map(({ jobId, fileId, source }) => ({
      jobId,
      fileId,
      source,
      status: 'queued',
      progress: 0,
      error: null,
      fileName: null,
    }))
    jobList.value = [...jobList.value, ...newJobs]
    startPolling()

    await nextTick()
    if (jobStatusAnchor.value) {
      jobStatusAnchor.value.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  } catch (err) {
    console.error('Failed to start optimisation', err)
    error.value = err.response?.data?.error || 'Failed to start optimisation'
    optimising.value = false
  }
}

async function pollJobs() {
  if (!pollingActive || jobList.value.length === 0) return
  try {
    const { data } = await axios.get('/api/optimise/status', { withCredentials: true })
    jobList.value = data.jobs || []
    handlePersistedPhotoJobErrors(jobList.value)
    optimising.value = jobList.value.some(
      (j) => j.status !== 'complete' && j.status !== 'error'
    )

    const allDone = jobList.value.every(
      (j) => j.status === 'complete' || j.status === 'error'
    )
    if (allDone) {
      stopPolling()
      optimising.value = false
      if (analysed.value) await analyseFiles()
      return
    }
  } catch {
    // Silently ignore poll errors
  }

  if (pollingActive) {
    pollTimer = setTimeout(async () => {
      pollTimer = null
      await pollJobs()
    }, 2000)
  }
}

function startPolling() {
  if (pollingActive) return
  pollingActive = true
  pollJobs()
}

function stopPolling() {
  pollingActive = false
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

async function clearOptimisationHistory() {
  error.value = null
  stopPolling()
  try {
    await axios.post('/api/optimise/clear', {}, { withCredentials: true })
    jobList.value = []
    optimising.value = false
  } catch (err) {
    console.error('Failed to clear optimisation history', err)
    error.value = err.response?.data?.error || 'Failed to clear optimisation history'
  }
}

// ---- Lifecycle ----

async function hydrateJobs() {
  try {
    const { data } = await axios.get('/api/optimise/status', { withCredentials: true })
    jobList.value = data.jobs || []
    handlePersistedPhotoJobErrors(jobList.value)
    optimising.value = jobList.value.some(
      (j) => j.status !== 'complete' && j.status !== 'error'
    )
    if (optimising.value) {
      startPolling()
    }
  } catch (err) {
    console.warn('Failed to hydrate optimisation jobs', err?.message || err)
  }
}

onMounted(async () => {
  // Check for auth error param in URL
  if (window.location.search.includes('error=auth_failed')) {
    authError.value = true
    window.history.replaceState({}, '', '/')
  }
  await checkAuth()
  if (authenticated.value) {
    const persistedPhotos = loadPersistedPhotoFiles()
    if (persistedPhotos.length > 0) {
      files.value = mergeFiles([], persistedPhotos)
      await validatePersistedPhotos(persistedPhotos)
    }
    await hydrateJobs()
    await analyseFiles()
  }
})

onUnmounted(stopPolling)
</script>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
  background: #f7fafc;
  color: #2d3748;
  min-height: 100vh;
}

#app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
</style>

<style scoped>
/* Header */
.header {
  background: #2b6cb0;
  color: white;
  padding: 0.75rem 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 2px 4px rgba(0,0,0,0.15);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.logo {
  width: 28px;
  height: 28px;
}

.user-area {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.4);
}

.user-name {
  font-size: 0.9rem;
}

/* Main */
.main {
  flex: 1;
  padding: 2rem 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

/* Login card */
.login-card {
  max-width: 440px;
  margin: 4rem auto;
  background: white;
  border-radius: 12px;
  padding: 2.5rem 2rem;
  box-shadow: 0 4px 16px rgba(0,0,0,0.08);
  text-align: center;
}

.login-card h1 {
  font-size: 1.6rem;
  margin-bottom: 0.75rem;
  color: #2b6cb0;
}

.login-card p {
  color: #718096;
  margin-bottom: 1.75rem;
  line-height: 1.6;
}

.btn-google {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  background: white;
  border: 1px solid #e2e8f0;
  color: #2d3748;
  padding: 0.65rem 1.4rem;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 500;
  text-decoration: none;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  transition: box-shadow 0.15s;
}

.btn-google:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.14);
}

.google-icon {
  width: 20px;
  height: 20px;
}

/* Dashboard */
.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.dashboard-header h2 {
  font-size: 1.25rem;
  color: #2d3748;
  margin: 0;
}

.header-buttons {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

/* Alerts */
.alert {
  padding: 0.75rem 1rem;
  border-radius: 8px;
  margin-bottom: 1rem;
  font-size: 0.9rem;
}

.alert-error {
  background: #fff5f5;
  color: #c53030;
  border: 1px solid #fed7d7;
}

/* Buttons */
.btn {
  padding: 0.5rem 1.1rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: background 0.15s;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 0.3rem 0.75rem;
  font-size: 0.8rem;
}

.btn-primary {
  background: #3182ce;
  color: white;
}

.btn-primary:not(:disabled):hover {
  background: #2c5282;
}

.btn-secondary {
  background: rgba(255,255,255,0.2);
  color: white;
  border: 1px solid rgba(255,255,255,0.3);
}

.btn-secondary:not(:disabled):hover {
  background: rgba(255,255,255,0.3);
}

/* ── Footer ── */
.app-footer {
  text-align: center;
  padding: 0.75rem 1rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  background: var(--bg);
  border-top: 1px solid var(--border);
}
</style>
