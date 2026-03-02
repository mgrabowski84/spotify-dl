const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load .env before anything else
const envPath = path.join(__dirname, '.env');
function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#\s][^=]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

function updateEnvVar(key, value) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content);
  process.env[key] = value;
}

const db = require('./db');
const queue = require('./queue');

const app = express();
const PORT = process.env.PORT || 3000;

let oauthState = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Spotify OAuth ---

app.get('/api/spotify/status', (_req, res) => {
  loadEnv();
  res.json({
    connected: !!(process.env.SPOTIFY_REFRESH),
    hasCredentials: !!(process.env.SPOTIFY_ID && process.env.SPOTIFY_SECRET),
  });
});

app.get('/api/spotify/auth', (req, res) => {
  loadEnv();
  if (!process.env.SPOTIFY_ID || !process.env.SPOTIFY_SECRET) {
    return res.status(400).json({ error: 'SPOTIFY_ID and SPOTIFY_SECRET must be set in .env' });
  }

  const redirectUri = `http://${req.headers.host}/api/spotify/callback`;
  oauthState = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_ID,
    scope: 'playlist-read-private playlist-read-collaborative user-library-read',
    redirect_uri: redirectUri,
    state: oauthState,
  });

  res.json({
    url: `https://accounts.spotify.com/authorize?${params}`,
    redirect_uri: redirectUri,
  });
});

app.get('/api/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px">
      <h2 style="color:#f85149">Auth failed: ${error}</h2><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
  }
  if (!code || state !== oauthState) {
    return res.status(400).send(`<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px">
      <h2 style="color:#f85149">Invalid state. Try again.</h2></body></html>`);
  }

  oauthState = null;
  loadEnv();
  const redirectUri = `http://${req.headers.host}/api/spotify/callback`;

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${process.env.SPOTIFY_ID}:${process.env.SPOTIFY_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });

    const data = await tokenRes.json();
    if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

    updateEnvVar('SPOTIFY_REFRESH', data.refresh_token);
    if (data.access_token) updateEnvVar('SPOTIFY_TOKEN', data.access_token);

    console.log('[spotify-dl] Spotify connected, refresh token saved');

    res.send(`<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <h2 style="color:#1db954">Spotify Connected</h2>
        <p>Refresh token saved. You can close this tab.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </div></body></html>`);
  } catch (err) {
    console.error('[spotify-dl] OAuth error:', err.message);
    res.status(500).send(`<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px">
      <h2 style="color:#f85149">Error</h2><p>${err.message}</p></body></html>`);
  }
});

// --- Download API ---

app.post('/api/download', (req, res) => {
  const { url, name } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  const trimmed = url.trim();
  if (
    !trimmed.match(/^https?:\/\/(open\.)?spotify\.com\/(playlist|album|track)\//) &&
    trimmed !== 'spotify-likes' &&
    trimmed !== 'spotify-albums'
  ) {
    return res.status(400).json({ error: 'Invalid Spotify URL. Provide a playlist, album, or track URL from open.spotify.com' });
  }
  const job = queue.enqueue(trimmed, name || null);
  res.status(201).json(job);
});

app.get('/api/jobs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  res.json(db.listJobs(limit, offset));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.getJob(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.delete('/api/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const job = db.getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'queued' || job.status === 'downloading') {
    return res.json(queue.cancelJob(id));
  }
  db.deleteJob(id);
  res.json({ deleted: true });
});

app.get('/api/jobs/:id/logs', (req, res) => {
  const id = parseInt(req.params.id);
  const job = db.getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  queue.addSseClient(id, res);
  req.on('close', () => queue.removeSseClient(id, res));
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

queue.init();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[spotify-dl] Server listening on port ${PORT}`);
  if (!process.env.SPOTIFY_REFRESH) {
    console.log('[spotify-dl] No Spotify refresh token — private playlists will not work. Visit the web UI to connect.');
  }
});
