(() => {
  const form = document.getElementById('download-form');
  const urlInput = document.getElementById('url-input');
  const nameInput = document.getElementById('name-input');
  const submitBtn = document.getElementById('submit-btn');
  const formError = document.getElementById('form-error');
  const jobsList = document.getElementById('jobs-list');
  const emptyState = document.getElementById('empty-state');
  const refreshBtn = document.getElementById('refresh-btn');
  const logSection = document.getElementById('log-section');
  const logOutput = document.getElementById('log-output');
  const logJobTitle = document.getElementById('log-job-title');
  const closeLogs = document.getElementById('close-logs');

  let currentLogJobId = null;
  let eventSource = null;
  let pollInterval = null;

  // --- API ---
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  }

  // --- Jobs List ---
  async function loadJobs() {
    try {
      const jobs = await api('GET', '/jobs?limit=50');
      renderJobs(jobs);
    } catch (e) {
      console.error('Failed to load jobs:', e);
    }
  }

  function renderJobs(jobs) {
    if (!jobs.length) {
      jobsList.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    jobsList.innerHTML = jobs.map(job => renderJobCard(job)).join('');

    jobsList.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', handleJobAction);
    });
  }

  function renderJobCard(job) {
    const name = job.playlist_name || extractName(job.url);
    const statusClass = `status-${job.status}`;
    const canCancel = job.status === 'queued' || job.status === 'downloading';
    const canDelete = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
    const canViewLogs = job.status === 'downloading' || job.status === 'completed' || job.status === 'failed';

    let stats = '';
    if (job.downloaded || job.failed) {
      const parts = [];
      if (job.downloaded) parts.push(`${job.downloaded} downloaded`);
      if (job.failed) parts.push(`${job.failed} failed`);
      stats = parts.join(', ');
    }
    if (job.track_count) {
      stats = `${job.track_count} tracks` + (stats ? ` | ${stats}` : '');
    }

    const timeStr = job.status === 'downloading' && job.started_at
      ? `Started ${formatTime(job.started_at)}`
      : job.finished_at
        ? `Finished ${formatTime(job.finished_at)}`
        : `Queued ${formatTime(job.created_at)}`;

    return `
      <div class="job-card" data-job-id="${job.id}">
        <div class="job-header">
          <div class="job-info">
            <div class="job-name">${escapeHtml(name)}</div>
            <div class="job-url">${escapeHtml(job.url)}</div>
            <div class="job-meta">
              <span class="status ${statusClass}">${job.status}</span>
              ${stats ? `<span>${stats}</span>` : ''}
              <span>${timeStr}</span>
            </div>
          </div>
          <div class="job-actions">
            ${canViewLogs ? `<button data-action="logs" data-id="${job.id}" data-name="${escapeAttr(name)}">Logs</button>` : ''}
            ${canCancel ? `<button data-action="cancel" data-id="${job.id}" class="danger">Cancel</button>` : ''}
            ${canDelete ? `<button data-action="delete" data-id="${job.id}" class="danger">Delete</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  async function handleJobAction(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'logs') {
      openLogs(parseInt(id), btn.dataset.name);
    } else if (action === 'cancel' || action === 'delete') {
      try {
        await api('DELETE', `/jobs/${id}`);
        loadJobs();
      } catch (e) {
        console.error('Action failed:', e);
      }
    }
  }

  // --- Log Viewer ---
  function openLogs(jobId, name) {
    closeLogs_();
    currentLogJobId = jobId;
    logJobTitle.textContent = `#${jobId} ${name || ''}`;
    logOutput.innerHTML = '';
    logSection.classList.remove('hidden');

    eventSource = new EventSource(`/api/jobs/${jobId}/logs`);
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'log') {
          appendLogLine(data.line);
        } else if (data.type === 'done') {
          appendLogLine(`\n--- Download ${data.status} ---`);
          loadJobs();
        }
      } catch (err) {
        // ignore
      }
    };
  }

  function appendLogLine(line) {
    const span = document.createElement('span');
    span.textContent = line + '\n';

    if (line.startsWith('Succeeded:') || line.startsWith('Skipped:')) {
      span.className = 'log-line-success';
    } else if (line.startsWith('Failed:') || line.startsWith('Not Found:')) {
      span.className = 'log-line-error';
    } else if (line.startsWith('[tidal]')) {
      span.className = 'log-line-search';
    } else if (line.startsWith('[spotify-dl]')) {
      span.className = 'log-line-system';
    }

    logOutput.appendChild(span);

    const isNearBottom = logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 100;
    if (isNearBottom) {
      logOutput.scrollTop = logOutput.scrollHeight;
    }
  }

  function closeLogs_() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    currentLogJobId = null;
    logSection.classList.add('hidden');
    logOutput.innerHTML = '';
  }

  closeLogs.addEventListener('click', closeLogs_);

  // --- Form Submit ---
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.add('hidden');
    submitBtn.disabled = true;

    const url = urlInput.value.trim();
    const name = nameInput.value.trim() || undefined;

    try {
      const job = await api('POST', '/download', { url, name });
      urlInput.value = '';
      nameInput.value = '';
      loadJobs();
      openLogs(job.id, job.playlist_name || extractName(url));
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
    }
  });

  // --- Refresh ---
  refreshBtn.addEventListener('click', loadJobs);

  // Auto-refresh every 5s
  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(loadJobs, 5000);
  }

  // --- Helpers ---
  function extractName(url) {
    const m = url.match(/\/(playlist|album)\/([a-zA-Z0-9]+)/);
    return m ? `${m[1]}/${m[2]}` : url;
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleDateString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --- Init ---
  loadJobs();
  startPolling();
})();
