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
    // Lead with the copy held by the most versions, then the longest-held one.
    exact.sort((a, b) =>
      (b.versions || 0) - (a.versions || 0) || timeOf(a.firstSeen) - timeOf(b.firstSeen))
    const best = exact[0]
    const earliest = exact.reduce((a, b) => (timeOf(b.firstSeen) < timeOf(a.firstSeen) ? b : a))
    const exactCopies = new Set(exact.map((m) => `${m.backupId}:${m.path}`))
    const others = matches.filter((m) => !exactCopies.has(`${m.backupId}:${m.path}`))
    const lines = [`Same name and size (${formatSize(file.size)}) found in Duplicati:`]
    for (const match of exact) lines.push('', ...describeCopy(match))
    if (others.length > 0) {
      lines.push('', 'Also found with this name but a different size:')
      for (const match of others) {
        for (const version of match.sizes) {
          lines.push(`${match.path} — ${formatSize(version.size)}${seenIn(version)}`)
        }
      }
    }
    return {
      state: 'backed-up',
      label: '✓ Backed up',
      detail: [
        best.versions ? `${best.versions} ${best.versions === 1 ? 'version' : 'versions'}` : null,
        earliest.firstSeen ? `since ${formatDate(earliest.firstSeen)}` : null,
      ].filter(Boolean).join(' · '),
      title: lines.join('\n'),
    }
  }

  const found = matches
    .flatMap((match) => match.sizes.map((version) => `${match.path} — ${formatSize(version.size)}${seenIn(version)}`))
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

// Tooltip lines for one backed-up copy of the file.
function describeCopy(match) {
  const lines = [`"${match.backupName}": ${match.path}`]
  if (match.versions) {
    lines.push(match.totalVersions
      ? `In ${match.versions} of ${match.totalVersions} backup versions`
      : `In ${match.versions} backup ${match.versions === 1 ? 'version' : 'versions'}`)
  }
  if (match.firstSeen) lines.push(`Earliest version: ${formatDateTime(match.firstSeen)}`)
  if (match.lastSeen && match.lastSeen !== match.firstSeen) {
    lines.push(`Latest version: ${formatDateTime(match.lastSeen)}`)
  }
  return lines
}

// e.g. " (3 versions, latest 4 Oct 2026)"
function seenIn(version) {
  const parts = []
  if (version.versions) parts.push(`${version.versions} ${version.versions === 1 ? 'version' : 'versions'}`)
  if (version.lastSeen) parts.push(`latest ${formatDate(version.lastSeen)}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

function timeOf(iso) {
  const time = iso ? new Date(iso).getTime() : NaN
  return Number.isNaN(time) ? Infinity : time
}

function formatDate(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateTime(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
