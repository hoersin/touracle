(function () {
  const state = {
    presets: [],
    jobs: [],
    datasets: [],
    lastEstimate: null,
    refreshTimer: null,
    formInteractionDepth: 0,
    overviewError: '',
  };

  const els = {
    heroStats: document.getElementById('heroStats'),
    regionPreset: document.getElementById('regionPreset'),
    jobLabel: document.getElementById('jobLabel'),
    startYear: document.getElementById('startYear'),
    endYear: document.getElementById('endYear'),
    tileKm: document.getElementById('tileKm'),
    oceanMode: document.getElementById('oceanMode'),
    coastalSeaKm: document.getElementById('coastalSeaKm'),
    chunkYears: document.getElementById('chunkYears'),
    minInterval: document.getElementById('minInterval'),
    chunkCount: document.getElementById('chunkCount'),
    chunkIndex: document.getElementById('chunkIndex'),
    latMin: document.getElementById('latMin'),
    latMax: document.getElementById('latMax'),
    lonMin: document.getElementById('lonMin'),
    lonMax: document.getElementById('lonMax'),
    paceUntil: document.getElementById('paceUntil'),
    estimateBtn: document.getElementById('estimateBtn'),
    startBtn: document.getElementById('startBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    estimatePanel: document.getElementById('estimatePanel'),
    jobsList: document.getElementById('jobsList'),
    datasetsList: document.getElementById('datasetsList'),
    jobsStatus: document.getElementById('jobsStatus'),
    datasetsStatus: document.getElementById('datasetsStatus'),
  };

  function isComposerActive() {
    return state.formInteractionDepth > 0 || els.jobLabel.matches(':focus');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function fmtNumber(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num.toLocaleString() : '0';
  }

  function fmtHours(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? `${num.toFixed(num >= 10 ? 1 : 2)} h` : '—';
  }

  function fmtPct(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? `${num.toFixed(1)}%` : '0%';
  }

  function fmtDate(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
  }

  function bboxText(bbox) {
    if (!bbox) return '—';
    return `${bbox.lat_min}..${bbox.lat_max} lat, ${bbox.lon_min}..${bbox.lon_max} lon`;
  }

  function statusClass(status) {
    const value = String(status || '').toLowerCase();
    if (['running'].includes(value)) return 'running';
    if (['completed', 'complete'].includes(value)) return 'complete';
    if (['partial', 'queued', 'stopped', 'stalled'].includes(value)) return 'partial';
    if (['failed', 'error', 'unreadable'].includes(value)) return 'error';
    if (['empty', 'missing'].includes(value)) return value;
    return 'partial';
  }

  function collectSpec() {
    return {
      region_slug: els.regionPreset.value,
      region_label: els.regionPreset.options[els.regionPreset.selectedIndex]?.textContent || '',
      start_year: Number(els.startYear.value),
      end_year: Number(els.endYear.value),
      tile_km: Number(els.tileKm.value),
      ocean: els.oceanMode.value,
      coastal_sea_km: Number(els.coastalSeaKm.value),
      chunk_years: Number(els.chunkYears.value),
      min_interval_s: Number(els.minInterval.value),
      chunk_count: Number(els.chunkCount.value),
      chunk_index: Number(els.chunkIndex.value),
      pace_until_berlin_7am: Boolean(els.paceUntil.checked),
      bbox: {
        lat_min: Number(els.latMin.value),
        lat_max: Number(els.latMax.value),
        lon_min: Number(els.lonMin.value),
        lon_max: Number(els.lonMax.value),
      },
    };
  }

  function applyPreset(slug) {
    const preset = state.presets.find((entry) => entry.slug === slug);
    if (!preset || !preset.bbox) return;
    els.latMin.value = preset.bbox.lat_min;
    els.latMax.value = preset.bbox.lat_max;
    els.lonMin.value = preset.bbox.lon_min;
    els.lonMax.value = preset.bbox.lon_max;
  }

  async function api(path, options) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }
    return response.json();
  }

  async function readApiError(response) {
    const fallback = `HTTP ${response.status}`;
    let text = '';
    try {
      text = await response.text();
    } catch {
      return fallback;
    }
    if (!text) {
      return fallback;
    }
    try {
      const payload = JSON.parse(text);
      const code = String(payload.error || '').trim();
      if (code === 'job_already_running') return 'The download is already running.';
      if (code === 'job_running') return 'Stop the active download before removing the job or deleting the database.';
      if (code === 'job_not_running') return 'No active download is running for this entry.';
      if (code === 'job_not_found') return 'The selected job no longer exists.';
      if (code === 'dataset_not_found') return 'The selected database was not found.';
      if (code === 'dataset_missing') return 'No database was selected.';
      if (code === 'unsupported_action') return 'This action is not supported.';
      if (payload.message) return String(payload.message);
      if (code) return code.replaceAll('_', ' ');
    } catch {
      // Fall back to raw text below.
    }
    return text || fallback;
  }

  function renderHero() {
    const jobsRunning = state.jobs.filter((job) => ['running', 'queued', 'stopping'].includes(job.status)).length;
    const datasetCount = state.datasets.length;
    const managedCount = state.datasets.filter((dataset) => dataset.managed).length;
    const partialCount = state.datasets.filter((dataset) => ['partial', 'error', 'running', 'empty', 'missing'].includes(dataset.status)).length;
    els.heroStats.innerHTML = `
      <div class="hero-stat">
        <div class="hero-stat-label">Running Jobs</div>
        <div class="hero-stat-value">${fmtNumber(jobsRunning)}</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-label">Known Databases</div>
        <div class="hero-stat-value">${fmtNumber(datasetCount)}</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-label">Managed Databases</div>
        <div class="hero-stat-value">${fmtNumber(managedCount)}</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-label">Need Attention</div>
        <div class="hero-stat-value">${fmtNumber(partialCount)}</div>
      </div>
    `;
  }

  function setOverviewError(error) {
    state.overviewError = error ? String(error.message || error) : '';
    const message = state.overviewError || 'Waiting for data...';
    els.jobsStatus.textContent = message;
    els.datasetsStatus.textContent = state.overviewError ? 'Retrying automatically...' : '';
    if (!state.jobs.length) {
      els.jobsList.innerHTML = `<div class="empty">${escapeHtml(state.overviewError || 'No managed jobs yet. Estimate one and start it here.')}</div>`;
    }
    if (!state.datasets.length) {
      els.datasetsList.innerHTML = `<div class="empty">${escapeHtml(state.overviewError || 'No offline tile databases found yet.')}</div>`;
    }
  }

  function renderEstimate() {
    if (!state.lastEstimate) {
      els.estimatePanel.innerHTML = `
        <div class="metric-label">Estimate</div>
        <div class="section-note" style="margin:0;">No estimate yet.</div>
      `;
      return;
    }
    const estimate = state.lastEstimate;
    const dbStatus = estimate.db_summary?.status || 'missing';
    els.estimatePanel.innerHTML = `
      <div class="card-top" style="margin-bottom:10px;">
        <div>
          <div class="metric-label">Estimate Ready</div>
          <div class="section-note" style="margin:4px 0 0;">${escapeHtml(estimate.spec.region_label)} · ${escapeHtml(String(estimate.spec.start_year))}-${escapeHtml(String(estimate.spec.end_year))}</div>
        </div>
        <span class="badge ${escapeHtml(statusClass(dbStatus))}">${escapeHtml(dbStatus)}</span>
      </div>
      <div class="estimate-grid">
        <div class="metric">
          <div class="metric-label">Expected Full Tile Count</div>
          <div class="metric-value">${fmtNumber(estimate.expected_full_tiles)}</div>
          <div class="metric-sub">Theoretical full grid after ocean filter: ${escapeHtml(estimate.ocean_mode_effective)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Expected Tiles In Selected Job</div>
          <div class="metric-value">${fmtNumber(estimate.expected_selected_tiles)}</div>
          <div class="metric-sub">Chunk ${fmtNumber(estimate.chunk_index + 1)} of ${fmtNumber(estimate.chunk_count)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Expected Requests</div>
          <div class="metric-value">${fmtNumber(estimate.expected_requests_total)}</div>
          <div class="metric-sub">${fmtNumber(estimate.expected_requests_per_tile)} requests per selected tile</div>
        </div>
        <div class="metric">
          <div class="metric-label">Estimated Runtime</div>
          <div class="metric-value">${fmtHours(estimate.estimated_hours)}</div>
          <div class="metric-sub">At ${escapeHtml(String(estimate.spec.min_interval_s))} sec minimum interval</div>
        </div>
      </div>
      <div class="metric" style="margin-top:10px;">
        <div class="metric-label">Target Database</div>
        <div class="metric-value" style="font-size:18px;">${escapeHtml(estimate.db_relpath)}</div>
        <div class="metric-sub">Existing status: ${escapeHtml(dbStatus)} · tiles currently present ${fmtNumber(estimate.db_summary?.tiles_total || 0)} · current progress ${fmtPct(estimate.db_summary?.progress_pct)}</div>
      </div>
    `;
  }

  function renderJobs() {
    els.jobsStatus.textContent = `${state.jobs.length} tracked job${state.jobs.length === 1 ? '' : 's'}`;
    if (!state.jobs.length) {
      els.jobsList.innerHTML = '<div class="empty">No managed jobs yet. Estimate one and start it here.</div>';
      return;
    }
    els.jobsList.innerHTML = state.jobs.map((job) => {
      const dbSummary = job.db_summary || {};
      const progress = Number(dbSummary.progress_pct || 0);
      return `
        <article class="panel job-card">
          <div class="card-top">
            <div>
              <h3 class="card-title">${escapeHtml(job.label || job.id)}</h3>
              <div class="card-subtitle">${escapeHtml(job.spec?.region_label || 'Region')} · years ${escapeHtml(String(job.spec?.start_year || ''))}-${escapeHtml(String(job.spec?.end_year || ''))} · ${escapeHtml(job.db_relpath || '')}</div>
            </div>
            <span class="badge ${escapeHtml(statusClass(job.status || 'missing'))}">${escapeHtml(job.status || 'unknown')}</span>
          </div>
          <div class="meta-grid">
            <div class="meta-box"><div class="k">Years</div><div class="v">${escapeHtml(String(job.spec?.start_year || ''))}-${escapeHtml(String(job.spec?.end_year || ''))}</div></div>
            <div class="meta-box"><div class="k">Area</div><div class="v">${escapeHtml(job.spec?.region_label || 'Custom')}</div></div>
            <div class="meta-box"><div class="k">Tiles Present</div><div class="v">${fmtNumber(dbSummary.done || 0)} / ${fmtNumber(dbSummary.tiles_total || 0)}</div></div>
            <div class="meta-box"><div class="k">Last Start</div><div class="v">${escapeHtml(fmtDate(job.started_at))}</div></div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, progress))}%;"></div></div>
          <div class="card-subtitle">${fmtPct(progress)} complete · errors ${fmtNumber(dbSummary.error || 0)} · running tiles ${fmtNumber(dbSummary.building || 0)}</div>
          <div class="actions" data-job-actions="${escapeHtml(job.id)}">
            <button class="ghost" data-action="refresh-log">Refresh Log</button>
            ${job.can_resume ? '<button class="ghost" data-action="resume">Resume</button>' : ''}
            ${job.can_stop ? '<button class="ghost" data-action="stop">Stop</button>' : ''}
            ${job.can_kill ? '<button class="danger" data-action="kill">Kill</button>' : ''}
            ${job.can_remove_job ? '<button class="danger" data-action="remove">Remove Job</button>' : ''}
          </div>
          <pre>${escapeHtml(job.log_tail || 'No log output yet.')}</pre>
        </article>
      `;
    }).join('');
  }

  function renderDatasets() {
    els.datasetsStatus.textContent = `${state.datasets.length} database${state.datasets.length === 1 ? '' : 's'} discovered`;
    if (!state.datasets.length) {
      els.datasetsList.innerHTML = '<div class="empty">No offline tile databases found yet.</div>';
      return;
    }
    els.datasetsList.innerHTML = state.datasets.map((dataset) => {
      const years = dataset.years || {};
      return `
        <article class="panel dataset-card">
          <div class="card-top">
            <div>
              <h3 class="card-title">${escapeHtml(dataset.db_relpath || dataset.db_path || 'database')}</h3>
              <div class="card-subtitle">${escapeHtml(bboxText(dataset.bbox))}</div>
            </div>
            <span class="badge ${escapeHtml(statusClass(dataset.status || 'missing'))}">${escapeHtml(dataset.status || 'unknown')}</span>
          </div>
          <div class="meta-grid">
            <div class="meta-box"><div class="k">Years</div><div class="v">${escapeHtml(String(years.start || '—'))} - ${escapeHtml(String(years.end || '—'))}</div></div>
            <div class="meta-box"><div class="k">Resolution</div><div class="v">${escapeHtml(String(dataset.tile_km || '—'))} km</div></div>
            <div class="meta-box"><div class="k">Tiles Present</div><div class="v">${fmtNumber(dataset.done || 0)} / ${fmtNumber(dataset.tiles_present || dataset.tiles_total || 0)}</div></div>
            <div class="meta-box"><div class="k">Runtime</div><div class="v">${dataset.active_pid ? `PID ${escapeHtml(String(dataset.active_pid))}` : 'idle'}</div></div>
            <div class="meta-box"><div class="k">Expected Full</div><div class="v">${fmtNumber(dataset.expected_full_tiles || 0)}</div></div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, Number(dataset.progress_pct || 0)))}%;"></div></div>
          <div class="card-subtitle">${fmtPct(dataset.progress_pct)} complete · errors ${fmtNumber(dataset.error || 0)} · last finish ${escapeHtml(fmtDate(dataset.last_build_finished_at))}</div>
          <div class="actions" data-dataset-actions="${escapeHtml(dataset.db_relpath || '')}">
            ${dataset.can_load_missing ? '<button class="ghost" data-action="load-missing">Load Missing</button>' : ''}
            ${dataset.can_stop ? '<button class="ghost" data-action="stop">Stop</button>' : ''}
            ${dataset.can_kill ? '<button class="danger" data-action="kill">Kill</button>' : ''}
            ${dataset.can_delete_db ? '<button class="danger" data-action="delete-db">Delete DB</button>' : ''}
          </div>
        </article>
      `;
    }).join('');
  }

  function renderAll() {
    renderHero();
    renderEstimate();
    renderJobs();
    renderDatasets();
    if (state.overviewError) {
      setOverviewError(state.overviewError);
    }
  }

  async function loadOverview() {
    try {
      const data = await api('/api/jobs');
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      state.datasets = Array.isArray(data.datasets) ? data.datasets : [];
      state.presets = Array.isArray(data.presets) ? data.presets : [];
      state.overviewError = '';
      if (!els.regionPreset.options.length) {
        els.regionPreset.innerHTML = state.presets.map((preset) => `<option value="${escapeHtml(preset.slug)}">${escapeHtml(preset.label)}</option>`).join('');
        const defaultPreset = state.presets.find((preset) => preset.default) || state.presets[0];
        if (defaultPreset) {
          els.regionPreset.value = defaultPreset.slug;
          applyPreset(defaultPreset.slug);
        }
      }
      renderAll();
    } catch (error) {
      setOverviewError(error);
    }
  }

  async function estimate() {
    els.estimateBtn.disabled = true;
    try {
      state.lastEstimate = await api('/api/estimate', {
        method: 'POST',
        body: JSON.stringify(collectSpec()),
      });
      renderEstimate();
    } finally {
      els.estimateBtn.disabled = false;
    }
  }

  async function startJob() {
    els.startBtn.disabled = true;
    try {
      const payload = collectSpec();
      payload.label = els.jobLabel.value.trim();
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await loadOverview();
    } finally {
      els.startBtn.disabled = false;
    }
  }

  async function postJobAction(jobId, action) {
    const response = await fetch(`/api/jobs/${jobId}${action === 'remove' ? '' : `/${action}`}`, {
      method: action === 'remove' ? 'DELETE' : 'POST',
    });
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }
    return response.json();
  }

  async function postDatasetAction(dbRelpath, action) {
    const response = await fetch('/api/datasets/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_relpath: dbRelpath, action }),
    });
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }
    return response.json();
  }

  async function refreshJobLog(jobId) {
    await api(`/api/jobs/${jobId}/log`);
    await loadOverview();
  }

  function confirmJobRemoval() {
    return window.confirm('Remove this job entry only? The database file will be kept.');
  }

  function confirmDatabaseDeletion() {
    return window.confirm('Delete this database and its local SQLite files? This cannot be undone.');
  }

  function bindEvents() {
    els.regionPreset.addEventListener('change', () => applyPreset(els.regionPreset.value));
    els.estimateBtn.addEventListener('click', () => estimate().catch((err) => window.alert(err.message)));
    els.startBtn.addEventListener('click', () => startJob().catch((err) => window.alert(err.message)));
    els.refreshBtn.addEventListener('click', () => loadOverview());

    document.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('.composer')) {
        state.formInteractionDepth += 1;
      }
    });

    document.addEventListener('focusout', (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('.composer')) {
        window.setTimeout(() => {
          const active = document.activeElement;
          state.formInteractionDepth = active instanceof HTMLElement && active.closest('.composer') ? 1 : 0;
        }, 0);
      }
    });

    els.jobsList.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const wrapper = button.closest('[data-job-actions]');
      const jobId = wrapper?.getAttribute('data-job-actions');
      const action = button.getAttribute('data-action');
      if (!jobId || !action) return;
      if (action === 'remove' && !confirmJobRemoval()) {
        return;
      }
      try {
        if (action === 'refresh-log') {
          await refreshJobLog(jobId);
        } else {
          await postJobAction(jobId, action);
          await loadOverview();
        }
      } catch (err) {
        window.alert(err.message || String(err));
      }
    });

    els.datasetsList.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const wrapper = button.closest('[data-dataset-actions]');
      const dbRelpath = wrapper?.getAttribute('data-dataset-actions');
      const action = button.getAttribute('data-action');
      if (!dbRelpath || !action) return;
      if (action === 'delete-db' && !confirmDatabaseDeletion()) {
        return;
      }
      try {
        await postDatasetAction(dbRelpath, action);
        await loadOverview();
      } catch (err) {
        window.alert(err.message || String(err));
      }
    });
  }

  function seedDefaults() {
    const now = new Date();
    els.startYear.value = String(now.getFullYear() - 10);
    els.endYear.value = String(now.getFullYear() - 1);
  }

  async function boot() {
    seedDefaults();
    bindEvents();
    setOverviewError('Waiting for data...');
    await loadOverview();
    state.refreshTimer = window.setInterval(() => {
      if (isComposerActive()) {
        return;
      }
      loadOverview();
    }, 3000);
  }

  boot().catch((err) => {
    console.error(err);
    setOverviewError(err);
  });
})();