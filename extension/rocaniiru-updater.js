(() => {
  const ENDPOINTS = ['http://127.0.0.1:8768', 'http://127.0.0.1:8767', 'http://127.0.0.1:8766'];
  let endpoint = null;
  const POLL_MS = 1500;
  let reloadAckInFlight = false;
  const id = (value) => document.getElementById(value);

  function ensureUi() {
    if (id('rocaniiruPatchPanel')) return;
    const style = document.createElement('style');
    style.textContent = `
      #rocaniiruPatchPanel{margin:0 0 16px;padding:12px 13px;border-radius:16px;background:var(--card,#1a1a1a);box-shadow:inset 0 0 0 1px var(--edge,rgba(255,255,255,.07));font:400 12px/1.4 var(--sans,system-ui);color:var(--text,#f2f2f2)}
      #rocaniiruPatchHead{display:flex;align-items:center;gap:10px}
      #rocaniiruPatchCopy{flex:1;min-width:0}
      #rocaniiruPatchTitle{font-size:12.5px;font-weight:600}
      #rocaniiruPatchMeta{margin-top:2px;color:var(--faint,#777);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #rocaniiruPatchBtn{flex:none;min-height:32px;padding:0 12px;border:0;border-radius:999px;background:var(--green,#1fbf75);color:#07130e;font:600 11.5px/1 system-ui;cursor:pointer}
      #rocaniiruPatchBtn:disabled{background:var(--hover,rgba(255,255,255,.05));color:var(--faint,#777);cursor:default}
      #rocaniiruPatchStatus{margin:8px 0 0;color:var(--faint,#777);font-size:10.5px;line-height:1.45}
      #rocaniiruPatchStatus.bad{color:var(--red,#ef6b62)}
    `;
    document.head.append(style);

    const panel = document.createElement('section');
    panel.id = 'rocaniiruPatchPanel';
    panel.innerHTML = `
      <div id="rocaniiruPatchHead">
        <div id="rocaniiruPatchCopy">
          <div id="rocaniiruPatchTitle">ROCANIIRU patch</div>
          <div id="rocaniiruPatchMeta">Checking…</div>
        </div>
        <button id="rocaniiruPatchBtn" type="button" disabled>Checking</button>
      </div>
      <p id="rocaniiruPatchStatus" role="status">Waiting for updater status.</p>
    `;
    const anchor = id('reloadStatus') || id('pill') || document.querySelector('header');
    if (anchor?.parentElement) anchor.insertAdjacentElement('afterend', panel);
    else document.body.prepend(panel);
    id('rocaniiruPatchBtn').addEventListener('click', apply);
  }

  async function request(path, options = {}) {
    const candidates = endpoint ? [endpoint, ...ENDPOINTS.filter((value) => value !== endpoint)] : ENDPOINTS;
    let lastError = null;
    for (const base of candidates) {
      try {
        const response = await fetch(`${base}${path}`, {
          cache: 'no-store',
          ...options,
          headers: { 'content-type': 'application/json', ...(options.headers || {}) }
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        endpoint = base;
        return body;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Updater endpoint unavailable');
  }

  function paint(status) {
    ensureUi();
    const button = id('rocaniiruPatchBtn');
    const meta = id('rocaniiruPatchMeta');
    const note = id('rocaniiruPatchStatus');
    const appVersion = status.appVersion || '?';
    const applied = status.appliedVersion || 'none';
    if (status.activationRequired === true) {
      meta.textContent = `App ${appVersion} · runtime package prepared`;
      button.disabled = true;
      button.textContent = 'Activation required';
      note.classList.remove('bad');
      note.textContent = status.message || 'Prepared only. Complete the controlled app/companion cutover before enabling TASK BOX.';
      return;
    }
    if (status.reloadRequired && !status.updateAvailable && !reloadAckInFlight) {
      reloadAckInFlight = true;
      button.disabled = true;
      button.textContent = 'Reloading…';
      note.textContent = 'Patch applied. Reloading the companion extension…';
      void request('/reload-ack', { method: 'POST', body: '{}' }).finally(() => {
        setTimeout(() => chrome.runtime.reload(), 250);
      });
      return;
    }
    meta.textContent = `App ${appVersion} · patch ${applied}`;
    note.classList.toggle('bad', Boolean(status.error));

    if (status.busy) {
      button.disabled = true;
      button.textContent = 'Updating…';
      note.textContent = status.message || 'Validating the new app version.';
      return;
    }
    if (status.updateAvailable) {
      button.disabled = false;
      button.textContent = status.error ? 'Retry' : 'Update patch';
      note.textContent = status.error || 'The app was updated. Patch this version after compatibility checks pass.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Up to date';
    note.textContent = status.message || 'This app version already has the ROCANIIRU patch.';
  }

  async function refresh() {
    ensureUi();
    try {
      paint(await request('/status'));
    } catch (error) {
      const button = id('rocaniiruPatchBtn');
      button.disabled = true;
      button.textContent = 'Updater offline';
      const note = id('rocaniiruPatchStatus');
      note.className = 'bad';
      note.textContent = `Updater unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function apply() {
    const button = id('rocaniiruPatchBtn');
    if (button.disabled) return;
    button.disabled = true;
    try {
      paint(await request('/apply', { method: 'POST', body: '{}' }));
    } catch (error) {
      const note = id('rocaniiruPatchStatus');
      note.className = 'bad';
      note.textContent = `Could not start update: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  ensureUi();
  void refresh();
  setInterval(() => void refresh(), POLL_MS);
})();
