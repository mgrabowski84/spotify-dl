const express = require('express');
const path = require('path');
const db = require('./db');
const queue = require('./queue');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---

// Submit a download
app.post('/api/download', (req, res) => {
  const { url, name } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  const trimmed = url.trim();

  // Validate it looks like a Spotify URL
  if (
    !trimmed.match(
      /^https?:\/\/(open\.)?spotify\.com\/(playlist|album|track)\//
    ) &&
    trimmed !== 'spotify-likes' &&
    trimmed !== 'spotify-albums'
  ) {
    return res.status(400).json({
      error:
        'Invalid Spotify URL. Provide a playlist, album, or track URL from open.spotify.com',
    });
  }

  const job = queue.enqueue(trimmed, name || null);
  res.status(201).json(job);
});

// List jobs
app.get('/api/jobs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const jobs = db.listJobs(limit, offset);
  res.json(jobs);
});

// Get single job
app.get('/api/jobs/:id', (req, res) => {
  const job = db.getJob(parseInt(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Cancel / delete a job
app.delete('/api/jobs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const job = db.getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.status === 'queued' || job.status === 'downloading') {
    const updated = queue.cancelJob(id);
    return res.json(updated);
  }

  // For completed/failed/cancelled jobs, delete from history
  db.deleteJob(id);
  res.json({ deleted: true });
});

// SSE log stream for a job
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

  req.on('close', () => {
    queue.removeSseClient(id, res);
  });
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SPA fallback (Express 5 syntax)
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
queue.init();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[spotify-dl] Server listening on port ${PORT}`);
});
