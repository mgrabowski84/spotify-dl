const { spawn } = require('child_process');
const path = require('path');
const db = require('./db');

const SLDL_BIN = process.env.SLDL_BIN || path.join(__dirname, 'bin', 'sldl');
const AUDIO_DIR = process.env.AUDIO_DIR || '/music';
const LISTEN_PORT = process.env.SLDL_LISTEN_PORT || '49997';

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
  // Send buffered logs
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
  // Cap at 10000 lines
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

function extractPlaylistName(url) {
  // Try to extract a meaningful name from the URL; sldl will resolve the real name
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match ? `spotify_${match[1]}` : `spotify_${Date.now()}`;
}

function buildSldlArgs(url, outputDir) {
  const args = [
    url,
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

  if (process.env.SPOTIFY_ID) {
    args.push('--spotify-id', process.env.SPOTIFY_ID);
  }
  if (process.env.SPOTIFY_SECRET) {
    args.push('--spotify-secret', process.env.SPOTIFY_SECRET);
  }
  if (process.env.SPOTIFY_REFRESH) {
    args.push('--spotify-refresh', process.env.SPOTIFY_REFRESH);
  }

  return args;
}

function runJob(job) {
  const jobId = job.id;
  currentJobId = jobId;

  const playlistName = job.playlist_name || extractPlaylistName(job.url);
  const folderName = sanitizeFolderName(playlistName);
  const outputDir = path.join(AUDIO_DIR, folderName);

  db.updateJob(jobId, {
    status: 'downloading',
    playlist_name: playlistName,
    started_at: new Date().toISOString(),
  });

  appendLog(jobId, `[spotify-dl] Starting download: ${job.url}`);
  appendLog(jobId, `[spotify-dl] Output: ${outputDir}`);

  const args = buildSldlArgs(job.url, outputDir);
  appendLog(jobId, `[spotify-dl] $ sldl ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

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
    // Capture track count from sldl output
    const trackMatch = line.match(/(\d+)\s+tracks?\s+found/i);
    if (trackMatch) {
      db.updateJob(jobId, { track_count: parseInt(trackMatch[1], 10) });
    }
  }

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.trim()) {
        appendLog(jobId, line);
        parseLine(line);
      }
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
    // Flush remaining buffers
    if (stdoutBuf.trim()) {
      appendLog(jobId, stdoutBuf.trim());
      parseLine(stdoutBuf.trim());
    }
    if (stderrBuf.trim()) appendLog(jobId, `[stderr] ${stderrBuf.trim()}`);

    const status = code === 0 ? 'completed' : 'failed';
    const error = code !== 0 ? `sldl exited with code ${code}` : null;

    appendLog(jobId, `[spotify-dl] Finished with status: ${status} (code ${code})`);
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

    // Process next in queue
    processQueue();
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
    processQueue();
  });
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
    setTimeout(() => {
      if (currentProcess) currentProcess.kill('SIGKILL');
    }, 5000);
    db.updateJob(jobId, { status: 'cancelled', finished_at: new Date().toISOString() });
    return db.getJob(jobId);
  }

  return job;
}

// On startup, reset any jobs stuck in 'downloading' (from a previous crash)
function init() {
  const d = db.getDb();
  d.prepare(
    "UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'downloading'"
  ).run();
  processQueue();
}

module.exports = {
  enqueue,
  cancelJob,
  getJobLogs,
  addSseClient,
  removeSseClient,
  processQueue,
  init,
};
