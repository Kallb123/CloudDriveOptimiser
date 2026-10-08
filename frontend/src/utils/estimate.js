// estimate.js — rough "what will I save?" estimates for the UI.
//
// NOTE: this is a rough heuristic for display only. It is not what the backend
// does; actual sizes depend on the content, source codec and encoder. The
// numbers are only meant to help users decide what is worth optimising.

// Video bitrate at 720p short side and CRF 28, in kbps.
const BASE_VIDEO_KBPS = 1800
const BASE_SHORT_SIDE = 720
const BASE_CRF = 28
// x264/x265-style: bitrate roughly halves for every +6 CRF.
const CRF_STEP_FOR_DOUBLING = 6
const AUDIO_KBPS = 128
// Without a duration, assume the re-encode keeps about this fraction of the
// pixel-scaled size.
const NO_DURATION_FACTOR = 0.6

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

export function formatSize(bytes) {
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

export function estimateOptimisedSize(file, { targetHeight, crf } = {}) {
  if (!file) return null
  const shortSide = positive(file.width) && positive(file.height)
    ? Math.min(file.width, file.height)
    : null
  const dimsKnown = shortSide !== null && positive(targetHeight)
  if (!dimsKnown) return null

  const outShort = Math.min(targetHeight, shortSide)
  let estimate = null

  if (positive(file.durationMillis) && Number.isFinite(crf)) {
    const videoKbps =
      BASE_VIDEO_KBPS *
      Math.pow(outShort / BASE_SHORT_SIDE, 2) *
      Math.pow(2, (BASE_CRF - crf) / CRF_STEP_FOR_DOUBLING)
    const seconds = file.durationMillis / 1000
    estimate = (seconds * (videoKbps + AUDIO_KBPS) * 1000) / 8
  } else if (positive(file.size)) {
    estimate = file.size * Math.pow(outShort / shortSide, 2) * NO_DURATION_FACTOR
  } else {
    return null
  }

  // Never estimate growth.
  if (positive(file.size)) estimate = Math.min(estimate, file.size)
  return Math.round(estimate)
}

export function estimateSaving(file, settings) {
  const estimate = estimateOptimisedSize(file, settings)
  if (estimate === null) return null
  return Math.max(0, (file.size || 0) - estimate)
}

export function summariseEstimates(files, settings) {
  let totalSize = 0
  let estimatedSize = 0
  let unknownCount = 0
  for (const file of files || []) {
    const size = positive(file.size) ? file.size : 0
    totalSize += size
    const estimate = estimateOptimisedSize(file, settings)
    if (estimate === null) {
      unknownCount++
      estimatedSize += size
    } else {
      estimatedSize += estimate
    }
  }
  return {
    count: (files || []).length,
    totalSize,
    estimatedSize,
    estimatedSaving: Math.max(0, totalSize - estimatedSize),
    unknownCount,
  }
}
