'use strict';

// Looks up videos in a Duplicati backup by filename, so originals can be
// confirmed as backed up before they are replaced.
//
// Uses the REST API that Duplicati's own web UI calls (Duplicati 2.1+):
//   POST /api/v1/auth/login                 { Password } -> { AccessToken }
//   GET  /api/v1/backups                    -> [{ Backup: { ID, Name } }]
//   GET  /api/v1/backup/{id}/files?filter=…&all-versions=true
//        -> { Filesets: [{ Version, Time }], Files: [{ Path, Sizes }] }
// Sizes line up with Filesets; -1 means the file is not in that version.

const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { requireAuth } = require('./drive');

const router = express.Router();

const DUPLICATI_URL = (process.env.DUPLICATI_URL || '').replace(/\/+$/, '');
const DUPLICATI_TOKEN = process.env.DUPLICATI_TOKEN || '';
const DUPLICATI_PASSWORD = process.env.DUPLICATI_PASSWORD || '';
const DUPLICATI_BACKUP_IDS = (process.env.DUPLICATI_BACKUP_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const LOG_PREFIX = '[backup-check]';
const REQUEST_TIMEOUT_MS = 60000;
// Names per Duplicati search (they share one regex filter).
const NAMES_PER_SEARCH = 25;
const MAX_NAMES_PER_REQUEST = 100;
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const BACKUP_LIST_TTL_MS = 10 * 60 * 1000;

function isEnabled() {
  return Boolean(DUPLICATI_URL && (DUPLICATI_TOKEN || DUPLICATI_PASSWORD));
}

let accessToken = DUPLICATI_TOKEN || null;
let backupListCache = null; // { at, backups: [{ id, name }] }
// lower-cased file name -> { at, matches }
const resultCache = new Map();

async function login() {
  if (!DUPLICATI_PASSWORD) {
    throw new Error('Duplicati rejected DUPLICATI_TOKEN — issue a new token or set DUPLICATI_PASSWORD');
  }
  const { data } = await axios.post(
    `${DUPLICATI_URL}/api/v1/auth/login`,
    { Password: DUPLICATI_PASSWORD, RememberMe: false },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  if (!data?.AccessToken) throw new Error('Duplicati login did not return an access token');
  accessToken = data.AccessToken;
}

// GET against the Duplicati API, logging in (again) when the token is missing
// or has expired.
async function duplicatiGet(urlPath, params) {
  if (!accessToken) await login();
  const request = () => axios.get(`${DUPLICATI_URL}${urlPath}`, {
    params,
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: REQUEST_TIMEOUT_MS,
  });
  try {
    return (await request()).data;
  } catch (err) {
    if (err.response?.status !== 401 || !DUPLICATI_PASSWORD) throw err;
    await login();
    return (await request()).data;
  }
}

async function listBackups() {
  if (backupListCache && Date.now() - backupListCache.at < BACKUP_LIST_TTL_MS) {
    return backupListCache.backups;
  }
  const data = await duplicatiGet('/api/v1/backups');
  let backups = (Array.isArray(data) ? data : [])
    .map((entry) => entry?.Backup)
    .filter((backup) => backup?.ID)
    .map((backup) => ({ id: String(backup.ID), name: backup.Name || `Backup ${backup.ID}` }));
  if (DUPLICATI_BACKUP_IDS.length > 0) {
    backups = backups.filter((backup) => DUPLICATI_BACKUP_IDS.includes(backup.id));
  }
  backupListCache = { at: Date.now(), backups };
  return backups;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
}

function baseName(filePath) {
  const parts = String(filePath).split(/[/\\]/);
  return parts[parts.length - 1];
}

// A Duplicati regex filter (wrapped in [ ]) matching any of the names as the
// last path segment, case-insensitively, on any platform's separators.
function buildNameFilter(names) {
  return `[(?i).*[/\\\\](?:${names.map(escapeRegex).join('|')})]`;
}

// Searches one backup for the given names; returns lower-cased name -> matches.
async function searchBackup(backup, names) {
  const data = await duplicatiGet(`/api/v1/backup/${encodeURIComponent(backup.id)}/files`, {
    filter: buildNameFilter(names),
    'all-versions': true,
  });
  const filesets = Array.isArray(data?.Filesets) ? data.Filesets : [];
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found = new Map();

  for (const file of Array.isArray(data?.Files) ? data.Files : []) {
    if (!file?.Path || /[/\\]$/.test(file.Path)) continue; // folders
    const key = baseName(file.Path).toLowerCase();
    if (!wanted.has(key)) continue;

    // Distinct sizes across versions, each with how many versions hold it and
    // the oldest and newest of those versions.
    const sizes = [];
    (file.Sizes || []).forEach((size, index) => {
      if (typeof size !== 'number' || size < 0) return;
      const time = filesets[index]?.Time || null;
      let entry = sizes.find((existing) => existing.size === size);
      if (!entry) {
        entry = { size, versions: 0, firstSeen: null, lastSeen: null };
        sizes.push(entry);
      }
      entry.versions += 1;
      if (time && (!entry.firstSeen || new Date(time) < new Date(entry.firstSeen))) entry.firstSeen = time;
      if (time && (!entry.lastSeen || new Date(time) > new Date(entry.lastSeen))) entry.lastSeen = time;
    });
    if (sizes.length === 0) continue;

    if (!found.has(key)) found.set(key, []);
    found.get(key).push({
      backupId: backup.id,
      backupName: backup.name,
      path: file.Path,
      totalVersions: filesets.length,
      sizes,
    });
  }
  return found;
}

// Looks up each name across the configured backups. Returns name -> matches.
async function checkNames(names, { refresh = false } = {}) {
  const now = Date.now();
  const results = {};
  const pending = [];
  for (const name of names) {
    const cached = resultCache.get(name.toLowerCase());
    if (!refresh && cached && now - cached.at < RESULT_CACHE_TTL_MS) {
      results[name] = cached.matches;
    } else {
      pending.push(name);
    }
  }
  if (pending.length === 0) return results;

  const backups = await listBackups();
  if (backups.length === 0) {
    throw new Error(DUPLICATI_BACKUP_IDS.length > 0
      ? 'None of DUPLICATI_BACKUP_IDS were found in Duplicati'
      : 'Duplicati has no backups configured');
  }

  const found = new Map();
  for (let i = 0; i < pending.length; i += NAMES_PER_SEARCH) {
    const batch = pending.slice(i, i + NAMES_PER_SEARCH);
    for (const backup of backups) {
      const backupMatches = await searchBackup(backup, batch);
      for (const [key, matches] of backupMatches) {
        if (!found.has(key)) found.set(key, []);
        found.get(key).push(...matches);
      }
    }
  }

  for (const name of pending) {
    const matches = found.get(name.toLowerCase()) || [];
    resultCache.set(name.toLowerCase(), { at: now, matches });
    results[name] = matches;
  }
  return results;
}

function describeError(err) {
  const status = err.response?.status;
  if (status === 401 || status === 403) return 'Duplicati refused the credentials — check DUPLICATI_TOKEN / DUPLICATI_PASSWORD';
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return `Could not reach Duplicati at ${DUPLICATI_URL}`;
  }
  const apiMessage = err.response?.data?.Error || err.response?.data?.Message;
  return apiMessage || err.message || 'Duplicati lookup failed';
}

/**
 * GET /api/backup-check/status
 * Whether a Duplicati server is configured, and which backups are searched.
 */
router.get('/status', requireAuth, async (req, res) => {
  if (!isEnabled()) return res.json({ enabled: false });
  try {
    const backups = await listBackups();
    return res.json({ enabled: true, backups });
  } catch (err) {
    console.warn(`${LOG_PREFIX} status failed:`, err.message);
    return res.json({ enabled: true, backups: [], error: describeError(err) });
  }
});

/**
 * POST /api/backup-check
 * Body: { names: [fileName, ...], refresh?: boolean }
 * Returns { results: { [fileName]: [{ backupName, path, totalVersions,
 *   sizes: [{ size, versions, firstSeen, lastSeen }] }] } },
 * where versions counts the backup versions holding the file at that size.
 * An empty list means the name wasn't found in any searched backup.
 */
router.post('/', requireAuth, async (req, res) => {
  if (!isEnabled()) return res.status(404).json({ error: 'Duplicati backup check is not configured' });

  const names = req.body?.names;
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES_PER_REQUEST
    || !names.every((name) => typeof name === 'string' && name && !/[/\\]/.test(name))) {
    return res.status(400).json({ error: `names must be an array of 1-${MAX_NAMES_PER_REQUEST} file names` });
  }

  try {
    const results = await checkNames([...new Set(names)], { refresh: req.body.refresh === true });
    return res.json({ results });
  } catch (err) {
    console.error(`${LOG_PREFIX} lookup failed:`, err.message);
    return res.status(502).json({ error: describeError(err) });
  }
});

module.exports = router;
module.exports.buildNameFilter = buildNameFilter;
