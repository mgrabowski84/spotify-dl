const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const SLDL_BIN = process.env.SLDL_BIN || path.join(__dirname, 'bin', 'sldl');
const AUDIO_DIR = process.env.AUDIO_DIR || '/music';
const LISTEN_PORT = process.env.SLDL_LISTEN_PORT || '49997';
const TRACKLISTS_DIR = path.join(__dirname, 'tracklists');

// In-memory log buffers and SSE clients per job
const jobLogs = new Map();    // jobId -> string[]
const sseClients = new Map(); // jobId -> Set<res>
let currentProcess = null;
let currentJobId = null;

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

// --- Spotify API helpers (client credentials, no OAuth) ---

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
  let url = `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks(total,next,items(track(name,artists(name))))`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Spotify API error ${res.status}: ${err.error?.message || res.statusText}`);
    }
    const data = await res.json();

    // First page has top-level name and tracks object; subsequent pages are just tracks
    if (data.name) playlistName = data.name;
    const tracksPage = data.tracks || data;

    for (const item of tracksPage.items || []) {
      if (!item.track) continue;
      const artist = item.track.artists?.[0]?.name || 'Unknown';
      const title = item.track.name || 'Unknown';
      tracks.push(`${artist} - ${title}`);
    }

    url = tracksPage.next || null;
    // For pagination beyond first page, switch to the tracks endpoint directly
    if (url && url.includes('/v1/playlists/') && url.includes('/tracks')) {
      // next URL is already correct
    }
  }

  return { playlistName, tracks };
}

function extractPlaylistId(url) {
  const m = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

// --- Job runner ---

async function runJob(job) {
  const jobId = job.id;
  currentJobId = jobId;

  db.updateJob(jobId, { status: 'downloading', started_at: new Date().toISOString() });
  appendLog(jobId, `[spotify-dl] Starting job #${jobId}: ${job.url}`);

  let tracklistPath = null;

  try {
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

    db.updateJob(jobId, { playlist_name: resolvedName, track_count: tracks.length });
    appendLog(jobId, `[spotify-dl] Playlist: "${resolvedName}" — ${tracks.length} tracks`);
    appendLog(jobId, `[spotify-dl] Output: ${outputDir}`);

    // 3. Write tracklist file
    if (!fs.existsSync(TRACKLISTS_DIR)) fs.mkdirSync(TRACKLISTS_DIR, { recursive: true });
    tracklistPath = path.join(TRACKLISTS_DIR, `${jobId}.txt`);
    fs.writeFileSync(tracklistPath, tracks.map(t => '"' + t.replace(/"/g, '\\"') + '"').join('\n') + '\n', 'utf-8');
    appendLog(jobId, `[spotify-dl] Tracklist written: ${tracklistPath}`);

    // 4. Run sldl
    const args = [
      '--input', tracklistPath,
      '--input-type', 'list',
      '--user', process.env.SOULSEEK_USER,
      '--pass', process.env.SOULSEEK_PASSWORD,
      '-p', outputDir,
      '--pref-format', 'flac',
      '--pref-min-bitrate', '320',
      '--name-format', '{artist} - {title}',
      '--fast-search',
      '--concurrent-downloads', '2',
      '--skip-check-pref-cond',
      '--listen-port', LISTEN_PORT,
    ];

    appendLog(jobId, `[spotify-dl] $ sldl ${args.map(a => (a && a.includes(' ')) ? `"${a}"` : (a ?? '<undef>')).join(' ')}`);

    await new Promise((resolve) => {
      const proc = spawn(SLDL_BIN, args, {
        cwd: __dirname,
        env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '0' },
      });
      currentProcess = proc;

      let succeeded = 0;
      let failed = 0;

      function parseLine(line) {
        if (line.startsWith('Succeeded:')) succeeded++;
        if (line.startsWith('Failed:') || line.startsWith('Not Found:')) failed++;
      }

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();
        for (const line of lines) {
          if (line.trim()) { appendLog(jobId, line); parseLine(line); }
        }
      });

      let stderrBuf = '';
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        for (const line of lines) {
          if (line.trim()) appendLog(jobId, `[stderr] ${line}`);
        }
      });

      proc.on('close', (code) => {
        if (stdoutBuf.trim()) { appendLog(jobId, stdoutBuf.trim()); parseLine(stdoutBuf.trim()); }
        if (stderrBuf.trim()) appendLog(jobId, `[stderr] ${stderrBuf.trim()}`);

        const status = code === 0 ? 'completed' : 'failed';
        const error = code !== 0 ? `sldl exited with code ${code}` : null;

        appendLog(jobId, `[spotify-dl] Finished: ${status} (code ${code})`);
        appendLog(jobId, `[spotify-dl] ${succeeded} succeeded, ${failed} failed`);

        db.updateJob(jobId, {
          status,
          downloaded: succeeded,
          failed,
          finished_at: new Date().toISOString(),
          error,
        });
        broadcast(jobId, 'done', { status, downloaded: succeeded, failed });

        currentProcess = null;
        currentJobId = null;
        resolve();
      });

      proc.on('error', (err) => {
        appendLog(jobId, `[spotify-dl] Process error: ${err.message}`);
        db.updateJob(jobId, {
          status: 'failed',
          finished_at: new Date().toISOString(),
          error: err.message,
        });
        broadcast(jobId, 'done', { status: 'failed', error: err.message });
        currentProcess = null;
        currentJobId = null;
        resolve();
      });
    });

  } catch (err) {
    appendLog(jobId, `[spotify-dl] Error: ${err.message}`);
    db.updateJob(jobId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: err.message,
    });
    broadcast(jobId, 'done', { status: 'failed', error: err.message });
    currentProcess = null;
    currentJobId = null;
  } finally {
    // Clean up tracklist file
    if (tracklistPath && fs.existsSync(tracklistPath)) {
      fs.unlinkSync(tracklistPath);
    }
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

  if (job.status === 'downloading' && currentJobId === jobId && currentProcess) {
    appendLog(jobId, '[spotify-dl] Killing download process...');
    currentProcess.kill('SIGTERM');
    setTimeout(() => { if (currentProcess) currentProcess.kill('SIGKILL'); }, 5000);
    db.updateJob(jobId, { status: 'cancelled', finished_at: new Date().toISOString() });
    return db.getJob(jobId);
  }

  return job;
}

function init() {
  const d = db.getDb();
  d.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'downloading'").run();
  processQueue();
}

module.exports = { enqueue, cancelJob, getJobLogs, addSseClient, removeSseClient, processQueue, init };
