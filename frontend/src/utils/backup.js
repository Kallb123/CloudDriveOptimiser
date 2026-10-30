// backup.js — turns Duplicati lookup results into a per-file backup status.

import { formatSize } from './estimate.js'

// entry is the lookup state for the file's name:
//   undefined            not checked
//   { checking: true }   lookup in flight
//   { error: '…' }       lookup failed
//   { matches: [...] }   result; [] means not found
export function backupStatus(file, entry) {
  if (!entry) return null
  if (entry.checking) {
    return { state: 'checking', label: 'Checking…', title: 'Looking this file up in Duplicati' }
  }
  if (entry.error) {
    return { state: 'error', label: 'Check failed', title: entry.error }
  }

  const matches = entry.matches || []
  if (matches.length === 0) {
    return {
      state: 'missing',
      label: 'Not in backup',
      title: `No file named "${file.name}" was found in any Duplicati backup version`,
    }
  }

  const exact = []
  for (const match of matches) {
    for (const version of match.sizes) {
      if (version.size === file.size) exact.push({ ...match, ...version })
    }
  }
  if (exact.length > 0) {
    const newest = exact.reduce((a, b) => ((b.lastSeen || '') > (a.lastSeen || '') ? b : a))
    return {
      state: 'backed-up',
      label: '✓ Backed up',
      title: `Same name and size in "${newest.backupName}": ${newest.path}` +
        (newest.lastSeen ? ` (newest backup version holding it: ${formatDateTime(newest.lastSeen)})` : ''),
    }
  }

  const found = matches
    .flatMap((match) => match.sizes.map((version) => `${match.path} — ${formatSize(version.size)}`))
    .join('\n')
  if (file.size == null) {
    return {
      state: 'size-differs',
      label: 'Found by name',
      title: `Found by name; this file's size is unknown so it couldn't be compared:\n${found}`,
    }
  }
  const photosNote = file.source === 'photos'
    ? '\nGoogle Photos may report a different size from the original file.'
    : ''
  return {
    state: 'size-differs',
    label: 'Size differs',
    title: `Found by name, but no backed-up version is ${formatSize(file.size)}:\n${found}${photosNote}`,
  }
}

function formatDateTime(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
