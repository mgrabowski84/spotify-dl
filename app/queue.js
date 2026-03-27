const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const db = require('./db');

const AUDIO_DIR = process.env.AUDIO_DIR || '/music';
const TIDAL_API_URL = process.env.TIDAL_API_URL || '';
const TIDAL_CONCURRENT = parseInt(process.env.TIDAL_CONCURRENT) || 3;
const UPTIME_URL = 'https://tidal-uptime.jiffy-puffs-1j.workers.dev/';
const FALLBACK_INSTANCES = [
  'https://eu-central.monochrome.tf',
  'https://frankfurt-1.monochrome.tf',
  'https://ohio-1.monochrome.tf',
  'https://singapore-1.monochrome.tf',
  'https://hifi.geeked.wtf',
];

// In-memory log buffers and SSE clients per job
const jobLogs = new Map();    // jobId -> string[]
const sseClients = new Map(); // jobId -> Set<res>
let currentJobId = null;
let cancelled = false;

// --- Streaming instance management ---

let streamingInstances = [];
let instanceIndex = 0;
let lastInstanceRefresh = 0;
const INSTANCE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function refreshInstances() {
  // If user specified a fixed instance, use only that
  if (TIDAL_API_URL) {
    streamingInstances = [TIDAL_API_URL];
    return;
  }

  try {
    const res = await fetch(UPTIME_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Streaming instances first (confirmed for downloads), then api instances as fallback
    const streaming = (data.streaming || []).map(i => i.url);
    const api = (data.api || []).map(i => i.url);
    // Deduplicated: streaming first, then api-only instances, then hardcoded fallbacks
    const seen = new Set();
    const combined = [];
    for (const url of [...streaming, ...api, ...FALLBACK_INSTANCES]) {
      if (!seen.has(url)) { seen.add(url); combined.push(url); }
    }

    if (combined.length > 0) {
      streamingInstances = combined;
    } else {
      streamingInstances = FALLBACK_INSTANCES;
    }
    lastInstanceRefresh = Date.now();
  } catch (err) {
    if (streamingInstances.length === 0) {
      streamingInstances = FALLBACK_INSTANCES;
    }
    // Keep existing list on error
  }
}

function getNextInstance() {
  if (streamingInstances.length === 0) return FALLBACK_INSTANCES[0];
  const instance = streamingInstances[instanceIndex % streamingInstances.length];
  instanceIndex++;
  return instance;
}

// Mark an instance as failed and remove from rotation
function markInstanceFailed(url) {
  streamingInstances = streamingInstances.filter(i => i !== url);
  if (streamingInstances.length === 0) {
    streamingInstances = FALLBACK_INSTANCES;
  }
}

// --- SSE / logging helpers (unchanged) ---

function getJobLogs(jobId) {
  return jobLogs.get(jobId) || [];
}

function addSseClient(jobId, res) {
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(res);
  const logs = getJobLogs(jobId);
  for (const line of logs) {
    res.write(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
  }
}

function removeSseClient(jobId, res) {
  const clients = sseClients.get(jobId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(jobId);
  }
}

function broadcast(jobId, type, data) {
  const clients = sseClients.get(jobId);
  if (!clients) return;
  const msg = JSON.stringify({ type, ...data });
  for (const res of clients) {
    res.write(`data: ${msg}\n\n`);
  }
}

function appendLog(jobId, line) {
  if (!jobLogs.has(jobId)) jobLogs.set(jobId, []);
  const logs = jobLogs.get(jobId);
  logs.push(line);
  if (logs.length > 10000) logs.shift();
  broadcast(jobId, 'log', { line });
}

function sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

function sanitizeFilename(str) {
  return str
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

// --- Spotify API helpers (unchanged) ---

async function getSpotifyToken() {
  const id = process.env.SPOTIFY_ID;
  const secret = process.env.SPOTIFY_SECRET;
  if (!id || !secret) throw new Error('SPOTIFY_ID and SPOTIFY_SECRET not set');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Spotify token error: ${data.error} - ${data.error_description}`);
  return data.access_token;
}

async function fetchPlaylistTracks(playlistId, token) {
  const tracks = [];
  let playlistName = null;
  let url = `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks(total,next,items(track(name,duration_ms,artists(name))))`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Spotify API error ${res.status}: ${err.error?.message || res.statusText}`);
    }
    const data = await res.json();

    if (data.name) playlistName = data.name;
    const tracksPage = data.tracks || data;

    for (const item of tracksPage.items || []) {
      if (!item.track) continue;
      const artist = item.track.artists?.[0]?.name || 'Unknown';
      const title = item.track.name || 'Unknown';
      const duration = item.track.duration_ms ? Math.round(item.track.duration_ms / 1000) : null;
      tracks.push({ artist, title, duration });
    }

    url = tracksPage.next || null;
  }

  return { playlistName, tracks };
}

function extractPlaylistId(url) {
  const m = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

// --- Tidal search & download ---

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTidalMatch(queryArtist, queryTitle, queryDuration, result) {
  const rArtist = normalize(result.artist?.name || '');
  const rTitle = normalize(result.title || '');
  const qArtist = normalize(queryArtist);
  const qTitle = normalize(queryTitle);

  let score = 0;

  // Artist scoring (0-5)
  if (rArtist === qArtist) {
    score += 5;
  } else if (rArtist.includes(qArtist) || qArtist.includes(rArtist)) {
    score += 3;
  } else {
    // Check if any significant words overlap
    const rWords = new Set(rArtist.split(' ').filter(w => w.length > 2));
    const qWords = qArtist.split(' ').filter(w => w.length > 2);
    const overlap = qWords.filter(w => rWords.has(w)).length;
    if (qWords.length > 0 && overlap / qWords.length >= 0.5) score += 2;
    else return -1; // Artist doesn't match at all
  }

  // Title scoring (0-6)
  if (rTitle === qTitle) {
    score += 6;
  } else if (rTitle.includes(qTitle) || qTitle.includes(rTitle)) {
    score += 4;
  } else {
    const rWords = new Set(rTitle.split(' ').filter(w => w.length > 1));
    const qWords = qTitle.split(' ').filter(w => w.length > 1);
    const overlap = qWords.filter(w => rWords.has(w)).length;
    if (qWords.length > 0 && overlap / qWords.length >= 0.6) score += 3;
    else return -1; // Title doesn't match
  }

  // Duration bonus/penalty (if both available)
  if (queryDuration && result.duration) {
    const diff = Math.abs(queryDuration - result.duration);
    if (diff <= 3) score += 1;
    else if (diff > 30) score -= 2;
  }

  return score;
}

async function searchTidal(artist, title, instance) {
  const query = `${artist} ${title}`;
  const url = `${instance}/search/?s=${encodeURIComponent(query)}&limit=5`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Tidal search HTTP ${res.status}`);
  const data = await res.json();

  return data.data?.items || [];
}

async function getTidalStreamUrl(trackId, instance) {
  // Try LOSSLESS first, then HI_RES_LOSSLESS
  for (const quality of ['LOSSLESS', 'HI_RES_LOSSLESS']) {
    try {
      const url = `${instance}/track/?id=${trackId}&quality=${quality}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json();

      const manifest = data.data?.manifest;
      if (!manifest) continue;

      // Manifest is base64-encoded JSON
      const decoded = JSON.parse(Buffer.from(manifest, 'base64').toString('utf-8'));
      if (decoded.urls && decoded.urls.length > 0) {
        return { url: decoded.urls[0], quality };
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function downloadFile(streamUrl, outputPath) {
  const res = await fetch(streamUrl, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);

  const tmpPath = outputPath + '.tmp';
  const dest = fs.createWriteStream(tmpPath);

  try {
    await pipeline(res.body, dest);
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    // Clean up temp file on error
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

async function downloadTrackFromTidal(track, index, total, outputDir, jobId) {
  const { artist, title, duration } = track;
  const tag = `[${index + 1}/${total}]`;

  appendLog(jobId, `[tidal] ${tag} Searching: ${artist} - ${title}`);

  // Try multiple instances with failover
  const triedInstances = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const instance = getNextInstance();
    if (triedInstances.has(instance) && streamingInstances.length > 1) continue;
    triedInstances.add(instance);

    try {
      // 1. Search
      const results = await searchTidal(artist, title, instance);
      if (!results.length) {
        appendLog(jobId, `Not Found: ${tag} ${artist} - ${title} (no Tidal results)`);
        return 'not_found';
      }

      // 2. Score and pick best match
      let bestResult = null;
      let bestScore = -1;

      for (const result of results) {
        const score = scoreTidalMatch(artist, title, duration, result);
        if (score > bestScore) {
          bestScore = score;
          bestResult = result;
        }
      }

      if (!bestResult || bestScore < 5) {
        const topResult = results[0];
        appendLog(jobId, `Not Found: ${tag} ${artist} - ${title} (best match score ${bestScore}: ${topResult?.artist?.name} - ${topResult?.title})`);
        return 'not_found';
      }

      // 3. Get stream URL
      const stream = await getTidalStreamUrl(bestResult.id, instance);
      if (!stream) {
        appendLog(jobId, `Failed: ${tag} ${artist} - ${title} (could not get stream URL from ${instance})`);
        markInstanceFailed(instance);
        lastError = new Error('No stream URL');
        continue; // Try another instance
      }

      // 4. Build output filename and check if exists
      const filename = sanitizeFilename(`${artist} - ${title}`) + '.flac';
      const outputPath = path.join(outputDir, filename);

      if (fs.existsSync(outputPath)) {
        appendLog(jobId, `Skipped: ${tag} ${artist} - ${title} (already exists)`);
        return 'skipped';
      }

      // 5. Download
      appendLog(jobId, `[tidal] ${tag} Downloading: ${bestResult.artist?.name} - ${bestResult.title} [${stream.quality}] (score: ${bestScore})`);
      await downloadFile(stream.url, outputPath);

      const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
      appendLog(jobId, `Succeeded: ${tag} ${artist} - ${title} (${sizeMb} MB)`);
      return 'downloaded';

    } catch (err) {
      lastError = err;
      if (err.name === 'TimeoutError' || err.message.includes('HTTP 5') || err.message.includes('HTTP 403')) {
        markInstanceFailed(instance);
      }
      continue; // Try another instance
    }
  }

  appendLog(jobId, `Failed: ${tag} ${artist} - ${title} (${lastError?.message || 'all instances failed'})`);
  return 'failed';
}

// --- Concurrency limiter ---

function createSemaphore(limit) {
  let active = 0;
  const queue = [];

  return {
    async acquire() {
      if (active < limit) {
        active++;
        return;
      }
      await new Promise(resolve => queue.push(resolve));
      active++;
    },
    release() {
      active--;
      if (queue.length > 0) {
        const next = queue.shift();
        next();
      }
    }
  };
}

// --- Job runner ---

async function runJob(job) {
  const jobId = job.id;
  currentJobId = jobId;
  cancelled = false;

  db.updateJob(jobId, { status: 'downloading', started_at: new Date().toISOString() });
  appendLog(jobId, `[spotify-dl] Starting job #${jobId}: ${job.url}`);

  try {
    // 0. Refresh Tidal instances
    if (Date.now() - lastInstanceRefresh > INSTANCE_REFRESH_INTERVAL || streamingInstances.length === 0) {
      appendLog(jobId, '[tidal] Refreshing API instance list...');
      await refreshInstances();
      appendLog(jobId, `[tidal] ${streamingInstances.length} instances available: ${streamingInstances.join(', ')}`);
    }

    // 1. Get Spotify token
    appendLog(jobId, '[spotify-dl] Fetching Spotify access token...');
    const token = await getSpotifyToken();

    // 2. Fetch playlist tracks
    const playlistId = extractPlaylistId(job.url);
    if (!playlistId) throw new Error('Could not extract playlist ID from URL');

    appendLog(jobId, `[spotify-dl] Fetching playlist tracks for ${playlistId}...`);
    const { playlistName, tracks } = await fetchPlaylistTracks(playlistId, token);

    if (!tracks.length) throw new Error('Playlist has no tracks');

    const resolvedName = job.playlist_name || playlistName || `spotify_${playlistId}`;
    const folderName = sanitizeFolderName(resolvedName);
    const outputDir = path.join(AUDIO_DIR, folderName);

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    db.updateJob(jobId, { playlist_name: resolvedName, track_count: tracks.length });
    appendLog(jobId, `[spotify-dl] Playlist: "${resolvedName}" -- ${tracks.length} tracks`);
    appendLog(jobId, `[spotify-dl] Output: ${outputDir}`);
    appendLog(jobId, `[tidal] Downloading with ${TIDAL_CONCURRENT} concurrent connections...`);

    // 3. Download all tracks from Tidal
    const sem = createSemaphore(TIDAL_CONCURRENT);
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    const downloadPromises = tracks.map((track, index) => {
      return (async () => {
        if (cancelled) return;
        await sem.acquire();
        if (cancelled) { sem.release(); return; }
        try {
          const result = await downloadTrackFromTidal(track, index, tracks.length, outputDir, jobId);
          if (result === 'downloaded' || result === 'skipped') succeeded++;
          else failed++;
          if (result === 'skipped') skipped++;
        } catch (err) {
          failed++;
          appendLog(jobId, `Failed: [${index + 1}/${tracks.length}] ${track.artist} - ${track.title} (${err.message})`);
        } finally {
          sem.release();
        }
      })();
    });

    await Promise.all(downloadPromises);

    if (cancelled) return; // Job was cancelled during download

    const status = failed === 0 ? 'completed' : (succeeded > 0 ? 'completed' : 'failed');

    appendLog(jobId, `[spotify-dl] Finished: ${status}`);
    appendLog(jobId, `[spotify-dl] ${succeeded} succeeded${skipped ? ` (${skipped} skipped)` : ''}, ${failed} not found/failed`);

    db.updateJob(jobId, {
      status,
      downloaded: succeeded,
      failed,
      finished_at: new Date().toISOString(),
    });
    broadcast(jobId, 'done', { status, downloaded: succeeded, failed });

  } catch (err) {
    appendLog(jobId, `[spotify-dl] Error: ${err.message}`);
    db.updateJob(jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: err.message,
    });
    broadcast(jobId, 'done', { status: 'failed', error: err.message });
  } finally {
    currentJobId = null;
  }

  processQueue();
}

function processQueue() {
  if (db.hasRunning()) return;
  const next = db.getNextQueued();
  if (next) runJob(next);
}

function enqueue(url, playlistName) {
  const job = db.createJob(url, playlistName);
  appendLog(job.id, `[spotify-dl] Job #${job.id} queued: ${url}`);
  processQueue();
  return job;
}

function cancelJob(jobId) {
  const job = db.getJob(jobId);
  if (!job) return null;

  if (job.status === 'queued') {
    db.updateJob(jobId, { status: 'cancelled', finished_at: new Date().toISOString() });
    appendLog(jobId, '[spotify-dl] Job cancelled');
    return db.getJob(jobId);
  }

  if (job.status === 'downloading' && currentJobId === jobId) {
    cancelled = true;
    appendLog(jobId, '[spotify-dl] Cancelling download...');
    db.updateJob(jobId, { status: 'cancelled', finished_at: new Date().toISOString() });
    return db.getJob(jobId);
  }

  return job;
}

function init() {
  const d = db.getDb();
  d.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'downloading'").run();
  // Pre-fetch instances on startup
  refreshInstances().then(() => {
    console.log(`[tidal] ${streamingInstances.length} streaming instances loaded`);
    processQueue();
  });
}

module.exports = { enqueue, cancelJob, getJobLogs, addSseClient, removeSseClient, processQueue, init };
