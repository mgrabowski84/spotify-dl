const express = require('express');
const path = require('path');
const fs = require('fs');

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

const db = require('./db');
const queue = require('./queue');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Download API ---

app.post('/api/download', (req, res) => {
  const { url, name } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  const trimmed = url.trim();
  if (!trimmed.match(/^https?:\/\/(open\.)?spotify\.com\/playlist\//)) {
    return res.status(400).json({ error: 'Invalid URL. Please provide a Spotify playlist URL (open.spotify.com/playlist/...)' });
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
});
