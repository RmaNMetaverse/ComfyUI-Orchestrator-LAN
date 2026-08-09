/* ComfyFleet web UI - vanilla JS, no framework. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: { fleet: {}, collect: {}, machines: [] },
  status: new Map(), // machine name -> ping result
  workflow: null, // { path, name, outline, ... }
  assets: [],
  overrides: [],
  busy: false,
  kind: null,
  progress: null,
  expandedNodes: new Set(),
};

/* ────────────────────────────────── utils ────────────────────────────────── */

const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fileName = (p) => String(p || '').split(/[\\/]/).pop();

function formatBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? 6000 : 3000);
}

/* ────────────────────────────────── theme ────────────────────────────────── */

const THEMES = ['auto', 'light', 'dark'];

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('cf-theme', theme);
}

applyTheme(localStorage.getItem('cf-theme') || 'auto');
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyTheme(localStorage.getItem('cf-theme') || 'auto');
});

$('#theme-toggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(localStorage.getItem('cf-theme') || 'auto') + 1) % THEMES.length];
  applyTheme(next);
  toast(`Appearance: ${next}`);
});

/* ────────────────────────── segmented controls / tabs ────────────────────── */

function moveThumb(group) {
  const active = $('.seg-item[aria-selected="true"]', group);
  const thumb = $('.seg-thumb', group);
  if (!active || !thumb) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`;
}

function bindSegmented(group, onPick, attribute) {
  group.addEventListener('click', (event) => {
    const item = event.target.closest('.seg-item');
    if (!item) return;
    $$('.seg-item', group).forEach((el) => el.setAttribute('aria-selected', String(el === item)));
    moveThumb(group);
    onPick(item.dataset[attribute]);
  });
  requestAnimationFrame(() => moveThumb(group));
}

bindSegmented($('#tabs'), (tab) => {
  $$('[data-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== tab));
  localStorage.setItem('cf-tab', tab);
}, 'tab');

bindSegmented($('#seed-mode'), (mode) => {
  $('#seed-value').classList.toggle('hidden', mode !== 'fixed');
  saveUi();
}, 'seed');

function selectTab(tab) {
  const item = $(`#tabs .seg-item[data-tab="${tab}"]`);
  if (item) item.click();
}

window.addEventListener('resize', () => $$('.segmented').forEach(moveThumb));

/* ─────────────────────────────── machines ────────────────────────────────── */

function machineCard(machine, index) {
  const info = state.status.get(machine.name);
  const live = state.progress?.machines?.find((m) => m.name === machine.name);

  let pill = '<span class="pill">not checked</span>';
  if (live && state.busy) {
    if (live.state === 'offline') pill = '<span class="pill pill-red"><span class="dot bg-ios-red"></span>dropped</span>';
    else if (live.state === 'refused') pill = '<span class="pill pill-orange">refused workflow</span>';
    else if (live.busy) pill = `<span class="pill pill-blue"><span class="dot bg-ios-blue dot-pulse"></span>running ${live.busy}</span>`;
    else pill = '<span class="pill pill-green"><span class="dot bg-ios-green"></span>idle</span>';
  } else if (info) {
    pill = info.online
      ? '<span class="pill pill-green"><span class="dot bg-ios-green"></span>online</span>'
      : '<span class="pill pill-red"><span class="dot bg-ios-red"></span>offline</span>';
  }

  const detail = info?.online
    ? `${esc(info.gpu)} · ${info.vramFreeGb} GB free · queue ${info.queue} · ComfyUI ${esc(info.comfyuiVersion)}`
    : info?.error
      ? esc(info.error)
      : machine.note
        ? esc(machine.note)
        : 'Press “Refresh status” to see this machine’s GPU';

  return `
    <div class="card">
      <div class="flex items-center gap-3 p-4">
        <input type="checkbox" class="ios-switch small" data-toggle="${index}" ${machine.enabled ? 'checked' : ''}
               title="Include this machine in runs" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[14px] font-semibold">${esc(machine.name)}</span>
            <span class="font-mono text-[12px] text-ios-gray">${esc(machine.host)}:${machine.port}</span>
            ${pill}
          </div>
          <p class="mt-0.5 truncate text-[12px] text-ios-gray">${detail}</p>
        </div>
        <div class="flex gap-1.5">
          <button class="btn-tiny" data-edit="${index}">Edit</button>
          <button class="btn-tiny danger" data-remove="${index}">Remove</button>
        </div>
      </div>
    </div>`;
}

function renderMachines() {
  const list = $('#machine-list');
  if (!state.config.machines.length) {
    list.innerHTML = `
      <div class="card">
        <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <div class="grid size-12 place-items-center rounded-2xl bg-black/5 dark:bg-white/10">
            <svg class="size-6 fill-current opacity-40" viewBox="0 0 24 24"><path d="M4 5h16v10H4V5Zm0 12h16v2H4v-2Zm2-9v6h12V8H6Z"/></svg>
          </div>
          <div>
            <p class="text-[14px] font-semibold">No machines yet</p>
            <p class="mt-1 text-[12px] text-ios-gray">Add a ComfyUI machine by address, or scan the network to find them.</p>
          </div>
          <div class="flex gap-2">
            <button class="btn-primary" data-action="add-machine">Add machine</button>
            <button class="btn-secondary" data-action="discover">Find on network</button>
          </div>
        </div>
      </div>`;
  } else {
    list.innerHTML = state.config.machines.map(machineCard).join('');
  }

  const enabled = state.config.machines.filter((m) => m.enabled).length;
  const online = [...state.status.values()].filter((s) => s.online).length;
  const summary = $('#fleet-summary');
  $('[data-count]', summary).textContent = state.status.size
    ? `${online}/${state.config.machines.length} online`
    : `${enabled} machine${enabled === 1 ? '' : 's'}`;
  $('span.size-1\\.5', summary)?.classList.toggle('bg-ios-green', online > 0);
}

$('#machine-list').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit]');
  const remove = event.target.closest('[data-remove]');
  if (edit) return machineDialog(Number(edit.dataset.edit));
  if (remove) {
    const index = Number(remove.dataset.remove);
    const machine = state.config.machines[index];
    confirmDialog(`Remove ${machine.name}?`, 'It can be added again at any time.', () => {
      state.config.machines.splice(index, 1);
      renderMachines();
      saveFleet(true);
    });
  }
});

$('#machine-list').addEventListener('change', (event) => {
  const toggle = event.target.closest('[data-toggle]');
  if (!toggle) return;
  state.config.machines[Number(toggle.dataset.toggle)].enabled = toggle.checked;
  renderMachines();
  saveFleet(true);
});

async function saveFleet(quiet = false) {
  state.config.collect = {
    ...state.config.collect,
    enabled: $('#collect-enabled').checked,
    destination: $('#destination').value.trim(),
    layout: $('#layout').value,
    overwrite: $('#overwrite').checked,
  };
  try {
    const { config } = await api('/api/fleet', { method: 'PUT', body: state.config });
    state.config = config;
    if (!quiet) toast('Machine list saved', 'good');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshStatus() {
  if (!state.config.machines.length) return;
  const button = $('[data-action="refresh-status"]');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const { machines } = await api('/api/status', { method: 'POST', body: {} });
    state.status = new Map(machines.map((m) => [m.name, m]));
    renderMachines();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh status';
  }
}

/* ─────────────────────────────── workflow ────────────────────────────────── */

function renderWorkflow() {
  const info = $('#workflow-info');
  const zone = $('#drop-zone');
  if (!state.workflow) {
    info.classList.add('hidden');
    zone.classList.remove('hidden');
    $('#node-tree').innerHTML = '<p class="px-3 py-6 text-center text-[12px] text-ios-gray">Choose a workflow to see its nodes.</p>';
    return;
  }
  zone.classList.add('hidden');
  info.classList.remove('hidden');

  const wf = state.workflow;
  const chip = (label) => `<span class="pill">${label}</span>`;
  info.innerHTML = `
    <div class="flex items-center gap-3 rounded-xl bg-black/4 dark:bg-white/6 p-3">
      <div class="grid size-9 flex-none place-items-center rounded-[9px] bg-ios-blue/15">
        <svg class="size-5 fill-ios-blue" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 2 4 4h-4V4Z"/></svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-[13px] font-semibold">${esc(wf.name)}</p>
        <p class="truncate font-mono text-[11px] text-ios-gray">${esc(wf.path)}</p>
      </div>
      <button class="btn-tiny" data-action="browse-workflow">Change</button>
    </div>
    <div class="mt-2 flex flex-wrap gap-1.5">
      ${chip(`${wf.nodeCount} nodes`)}${chip(`${wf.classCount} node types`)}
      ${chip(`${wf.seedWidgets} seed widget${wf.seedWidgets === 1 ? '' : 's'}`)}
      ${wf.assetRefs.length ? chip(`needs ${wf.assetRefs.map(esc).join(', ')}`) : ''}
    </div>`;

  renderNodeTree();
  checkAssetCoverage();
}

function renderNodeTree() {
  const tree = $('#node-tree');
  if (!state.workflow) return;
  tree.innerHTML = state.workflow.outline
    .map((node) => {
      const open = state.expandedNodes.has(node.id);
      const widgets = node.widgets
        .map(
          (w) => `
          <button class="widget-row" data-node="${esc(node.id)}" data-field="${esc(w.field)}"
                  data-value="${esc(JSON.stringify(w.value))}" title="Override this setting">
            <span class="font-medium">${esc(w.field)}</span>
            <span class="widget-value">${esc(String(w.value))}</span>
          </button>`,
        )
        .join('');
      return `
        <div class="py-0.5">
          <button class="node-row" data-toggle-node="${esc(node.id)}">
            <svg class="size-3.5 flex-none fill-current opacity-50 transition-transform ${open ? 'rotate-90' : ''}"
                 viewBox="0 0 24 24"><path d="M9 6l6 6-6 6V6Z"/></svg>
            <span class="text-[12px] font-semibold">${esc(node.title)}</span>
            <span class="ml-auto font-mono text-[10px] text-ios-gray">#${esc(node.id)}</span>
          </button>
          ${open ? `<div class="pb-1">${widgets || '<p class="px-8 py-1 text-[11px] text-ios-gray">nothing editable</p>'}</div>` : ''}
        </div>`;
    })
    .join('');
}

$('#node-tree').addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle-node]');
  if (toggle) {
    const id = toggle.dataset.toggleNode;
    if (state.expandedNodes.has(id)) state.expandedNodes.delete(id);
    else state.expandedNodes.add(id);
    return renderNodeTree();
  }
  const widget = event.target.closest('[data-node][data-field]');
  if (widget) {
    let value;
    try { value = JSON.parse(widget.dataset.value); } catch { value = widget.dataset.value; }
    overrideDialog(null, { node: widget.dataset.node, field: widget.dataset.field, value });
  }
});

async function loadWorkflow(payload) {
  try {
    state.workflow = await api('/api/workflow', { method: 'POST', body: payload });
    state.expandedNodes = new Set();
    renderWorkflow();
    saveUi();
    toast(`Loaded ${state.workflow.name}`, 'good');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// drag and drop a workflow json onto the page
const zone = $('#drop-zone');
['dragenter', 'dragover'].forEach((type) =>
  zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) =>
  zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('dragging'); }));
zone.addEventListener('drop', async (event) => {
  const file = event.dataTransfer.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.json')) return toast('That is not a .json workflow', 'error');
  try {
    loadWorkflow({ name: file.name, data: JSON.parse(await file.text()) });
  } catch {
    toast('That file is not valid JSON', 'error');
  }
});

/* ──────────────────────────────── assets ─────────────────────────────────── */

function renderAssets() {
  const list = $('#asset-list');
  if (!state.assets.length) {
    list.innerHTML = '<p class="px-4 pb-1 pt-0 text-[12px] text-ios-gray">Nothing added. Only needed if the workflow loads a video, image or audio file.</p>';
  } else {
    list.innerHTML = state.assets
      .map(
        (asset, index) => `
        <div class="flex items-center gap-3 px-4 py-2.5">
          <svg class="size-4 flex-none fill-current opacity-40" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/></svg>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-medium">${esc(fileName(asset))}</p>
            <p class="truncate font-mono text-[11px] text-ios-gray">${esc(asset)}</p>
          </div>
          <button class="btn-tiny danger" data-remove-asset="${index}">Remove</button>
        </div>`,
      )
      .join('');
  }
  checkAssetCoverage();
}

/** Warn in the UI when the workflow needs an input file nobody has added. */
function checkAssetCoverage() {
  if (!state.workflow?.assetRefs?.length) return;
  const have = new Set(state.assets.map((a) => fileName(a).toLowerCase()));
  const missing = state.workflow.assetRefs.filter((ref) => !have.has(fileName(ref).toLowerCase()));
  const list = $('#asset-list');
  if (!missing.length || !list) return;
  const note = document.createElement('div');
  note.className = 'mx-4 mb-1 mt-2 rounded-xl bg-ios-orange/12 px-3 py-2.5 text-[12px] leading-relaxed';
  note.innerHTML = `<span class="font-semibold">${missing.map(esc).join(', ')}</span> ${missing.length === 1 ? 'is' : 'are'}
    loaded by this workflow but not added here — add ${missing.length === 1 ? 'it' : 'them'} above, or make sure
    ${missing.length === 1 ? 'it already sits' : 'they already sit'} in each machine's <span class="font-mono">ComfyUI\\input</span> folder.`;
  list.append(note);
}

$('#asset-list').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-asset]');
  if (!remove) return;
  state.assets.splice(Number(remove.dataset.removeAsset), 1);
  renderAssets();
  saveUi();
});

/* ─────────────────────────────── overrides ───────────────────────────────── */

function renderOverrides() {
  const list = $('#override-list');
  if (!state.overrides.length) {
    list.innerHTML = '<p class="px-4 pb-1 text-[12px] text-ios-gray">None. Tap a setting in the node list to override it.</p>';
    return;
  }
  list.innerHTML = state.overrides
    .map((o, index) => {
      const by = o.node ? 'node' : o.title ? 'title' : 'class';
      const target = o.node || o.title || o.class;
      return `
        <div class="flex items-center gap-3 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px]">
              <span class="pill mr-1.5">${by}</span>
              <span class="font-semibold">${esc(target)}</span>
              <span class="text-ios-gray"> · ${esc(o.field)}</span>
            </p>
            <p class="mt-0.5 truncate font-mono text-[11px] text-ios-gray">${esc(String(o.value))}</p>
          </div>
          <button class="btn-tiny" data-edit-override="${index}">Edit</button>
          <button class="btn-tiny danger" data-remove-override="${index}">Remove</button>
        </div>`;
    })
    .join('');
}

$('#override-list').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-override]');
  const remove = event.target.closest('[data-remove-override]');
  if (edit) return overrideDialog(Number(edit.dataset.editOverride));
  if (remove) {
    state.overrides.splice(Number(remove.dataset.removeOverride), 1);
    renderOverrides();
    saveUi();
  }
});

/* ──────────────────────────────── modals ────────────────────────────────── */

function openSheet({ title, subtitle = '', body, footer, onMount, width = '32rem' }) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `
    <div class="sheet" style="max-width:${width}" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <h3 class="text-[17px] font-semibold tracking-[-0.01em]">${esc(title)}</h3>
        ${subtitle ? `<p class="mt-1 text-[12px] leading-relaxed text-ios-gray">${subtitle}</p>` : ''}
      </div>
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot">${footer}</div>
    </div>`;
  root.append(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  onMount?.(backdrop, close);
  $('input, select, textarea, button', backdrop)?.focus();
  return close;
}

function confirmDialog(title, subtitle, onConfirm) {
  openSheet({
    title, subtitle, body: '', width: '24rem',
    footer: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-danger" data-ok>Remove</button>',
    onMount: (root, close) => {
      $('[data-close]', root).onclick = close;
      $('[data-ok]', root).onclick = () => { close(); onConfirm(); };
    },
  });
}

function machineDialog(index = null) {
  const machine = index === null
    ? { name: '', host: '', port: 8000, slots: 2, note: '', enabled: true }
    : { ...state.config.machines[index] };

  openSheet({
    title: index === null ? 'Add machine' : 'Edit machine',
    subtitle: 'ComfyUI Desktop listens on port 8000, the portable build on 8188.',
    body: `
      <div class="space-y-3 pb-2">
        <div><label class="field-label">Name</label>
          <input class="field w-full" data-f="name" value="${esc(machine.name)}" placeholder="GPU-01" /></div>
        <div><label class="field-label">IP address or host name</label>
          <input class="field w-full" data-f="host" value="${esc(machine.host)}" placeholder="192.168.1.51" spellcheck="false" /></div>
        <div class="flex gap-3">
          <div class="flex-1"><label class="field-label">Port</label>
            <input class="field w-full" type="number" data-f="port" value="${machine.port}" /></div>
          <div class="flex-1"><label class="field-label">Parallel slots</label>
            <input class="field w-full" type="number" min="1" data-f="slots" value="${machine.slots}" /></div>
        </div>
        <div><label class="field-label">Note</label>
          <input class="field w-full" data-f="note" value="${esc(machine.note)}" placeholder="RTX 4090" /></div>
      </div>`,
    footer: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" data-ok>Save</button>',
    onMount: (root, close) => {
      $('[data-close]', root).onclick = close;
      $('[data-ok]', root).onclick = () => {
        const get = (f) => $(`[data-f="${f}"]`, root).value.trim();
        const host = get('host');
        if (!host) return toast('An IP address or host name is required', 'error');
        const updated = {
          ...machine,
          name: get('name') || host,
          host,
          port: Number(get('port')) || 8000,
          slots: Math.max(1, Number(get('slots')) || 1),
          note: get('note'),
        };
        if (index === null) state.config.machines.push(updated);
        else state.config.machines[index] = updated;
        close();
        renderMachines();
        saveFleet(true);
      };
    },
  });
}

function overrideDialog(index = null, prefill = null) {
  const existing = index === null ? null : state.overrides[index];
  const by = existing ? (existing.node ? 'node' : existing.title ? 'title' : 'class') : 'node';
  const target = existing ? existing.node || existing.title || existing.class : prefill?.node || '';
  const field = existing ? existing.field : prefill?.field || '';
  const value = existing ? existing.value : prefill?.value ?? '';

  openSheet({
    title: index === null ? 'Add override' : 'Edit override',
    subtitle: 'Numbers are sent as numbers, true/false as booleans, everything else as text.',
    body: `
      <div class="space-y-3 pb-2">
        <div>
          <label class="field-label">Select the node by</label>
          <div class="segmented segmented-sm" data-by>
            ${['node', 'title', 'class'].map((k) => `<button class="seg-item" data-k="${k}" aria-selected="${String(k === by)}">${k === 'node' ? 'node id' : k}</button>`).join('')}
            <div class="seg-thumb"></div>
          </div>
        </div>
        <div><label class="field-label">Target</label>
          <input class="field w-full" data-f="target" value="${esc(target)}" placeholder="6" /></div>
        <div><label class="field-label">Setting</label>
          <input class="field w-full" data-f="field" value="${esc(field)}" placeholder="text" /></div>
        <div><label class="field-label">Value</label>
          <textarea class="field w-full" rows="4" data-f="value" spellcheck="false">${esc(typeof value === 'string' ? value : JSON.stringify(value))}</textarea></div>
      </div>`,
    footer: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" data-ok>Save</button>',
    onMount: (root, close) => {
      let chosen = by;
      const group = $('[data-by]', root);
      bindSegmented(group, (k) => { chosen = k; }, 'k');
      requestAnimationFrame(() => moveThumb(group));
      $('[data-close]', root).onclick = close;
      $('[data-ok]', root).onclick = () => {
        const targetValue = $('[data-f="target"]', root).value.trim();
        const fieldValue = $('[data-f="field"]', root).value.trim();
        if (!targetValue || !fieldValue) return toast('Target and setting are both required', 'error');
        const raw = $('[data-f="value"]', root).value;
        const override = {
          node: chosen === 'node' ? targetValue : null,
          title: chosen === 'title' ? targetValue : null,
          class: chosen === 'class' ? targetValue : null,
          field: fieldValue,
          value: coerce(raw),
        };
        if (index === null) state.overrides.push(override);
        else state.overrides[index] = override;
        close();
        renderOverrides();
        saveUi();
      };
    },
  });
}

function coerce(raw) {
  const text = raw.trim();
  if (text === 'true' || text === 'false') return text === 'true';
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text);
  return raw;
}

/* ───────────────────────────── file browser ─────────────────────────────── */

function browseDialog({ title, only = 'all', extensions = null, multiple = false, start = null, onPick }) {
  let cwd = start;
  const picked = new Set();

  const close = openSheet({
    title,
    subtitle: 'These are the folders on the machine running ComfyFleet.',
    width: '38rem',
    body: `
      <div class="pb-2">
        <div class="mb-2 flex items-center gap-2">
          <button class="btn-tiny" data-up>↑ Up</button>
          <input class="field flex-1 font-mono text-[11px]" data-path spellcheck="false" />
          <button class="btn-tiny" data-go>Go</button>
        </div>
        <div data-drives class="mb-2 flex flex-wrap gap-1.5"></div>
        <div data-entries class="max-h-[46vh] min-h-[12rem] overflow-y-auto rounded-xl bg-black/3 dark:bg-white/5 p-1"></div>
      </div>`,
    footer: `<button class="btn-secondary" data-close>Cancel</button>
             <button class="btn-primary" data-ok>${only === 'dirs' ? 'Use this folder' : 'Choose'}</button>`,
    onMount: (root, closeSheet) => {
      const entriesEl = $('[data-entries]', root);
      const pathEl = $('[data-path]', root);

      async function load(target) {
        const params = new URLSearchParams({ only });
        if (target) params.set('path', target);
        if (extensions) params.set('ext', extensions.join(','));
        let data;
        try {
          data = await api(`/api/browse?${params}`);
        } catch (err) {
          return toast(err.message, 'error');
        }
        cwd = data.cwd;
        pathEl.value = data.cwd;
        picked.clear();
        $('[data-drives]', root).innerHTML = data.drives
          .map((d) => `<button class="btn-tiny" data-drive="${esc(d)}">${esc(d)}</button>`).join('');
        entriesEl.innerHTML = data.error
          ? `<p class="p-4 text-center text-[12px] text-ios-red">${esc(data.error)}</p>`
          : data.entries.length
            ? data.entries.map((entry, i) => `
                <button class="browse-item" data-i="${i}" data-dir="${entry.dir}" data-p="${esc(entry.path)}">
                  <svg class="size-4 flex-none fill-current ${entry.dir ? 'opacity-70' : 'opacity-35'}" viewBox="0 0 24 24">
                    ${entry.dir
                      ? '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/>'
                      : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/>'}
                  </svg>
                  <span class="min-w-0 flex-1 truncate">${esc(entry.name)}</span>
                  ${entry.dir ? '<span class="text-ios-gray">›</span>' : `<span class="text-[11px] text-ios-gray">${formatBytes(entry.size)}</span>`}
                </button>`).join('')
            : '<p class="p-4 text-center text-[12px] text-ios-gray">Nothing here</p>';
      }

      entriesEl.addEventListener('click', (event) => {
        const item = event.target.closest('.browse-item');
        if (!item) return;
        if (item.dataset.dir === 'true') return load(item.dataset.p);
        if (multiple) {
          item.classList.toggle('picked');
          if (picked.has(item.dataset.p)) picked.delete(item.dataset.p);
          else picked.add(item.dataset.p);
        } else {
          closeSheet();
          onPick([item.dataset.p]);
        }
      });

      $('[data-up]', root).onclick = async () => {
        const data = await api(`/api/browse?path=${encodeURIComponent(cwd)}`);
        if (data.parent) load(data.parent);
      };
      $('[data-go]', root).onclick = () => load(pathEl.value.trim());
      pathEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(pathEl.value.trim()); });
      $('[data-drives]', root).addEventListener('click', (event) => {
        const drive = event.target.closest('[data-drive]');
        if (drive) load(drive.dataset.drive);
      });
      $('[data-close]', root).onclick = closeSheet;
      $('[data-ok]', root).onclick = () => {
        closeSheet();
        onPick(only === 'dirs' ? [cwd] : [...picked]);
      };

      load(start);
    },
  });
  return close;
}

function discoverDialog() {
  openSheet({
    title: 'Find ComfyUI machines',
    subtitle: 'Scans the addresses you give it and lists everything that answers.',
    width: '38rem',
    body: `
      <div class="pb-2">
        <div class="mb-3 flex gap-2">
          <input class="field flex-1" data-range placeholder="192.168.1.0/24" spellcheck="false" />
          <input class="field w-40" data-ports value="8000,8188,8189" spellcheck="false" />
          <button class="btn-primary" data-scan>Scan</button>
        </div>
        <p class="mb-2 text-[11px] text-ios-gray">Ranges like <span class="font-mono">192.168.1.0/24</span>
          or <span class="font-mono">192.168.1.10-60</span>, or a single address.</p>
        <div data-results class="max-h-[42vh] min-h-[10rem] overflow-y-auto rounded-xl bg-black/3 dark:bg-white/5 p-1">
          <p class="p-6 text-center text-[12px] text-ios-gray">No scan yet</p>
        </div>
      </div>`,
    footer: '<button class="btn-secondary" data-close>Close</button><button class="btn-primary" data-ok>Add selected</button>',
    onMount: (root, close) => {
      let found = [];
      const results = $('[data-results]', root);
      const chosen = new Set();

      $('[data-scan]', root).onclick = async () => {
        const button = $('[data-scan]', root);
        button.disabled = true;
        button.textContent = 'Scanning…';
        results.innerHTML = '<p class="p-6 text-center text-[12px] text-ios-gray">Scanning the network…</p>';
        try {
          const body = {
            range: $('[data-range]', root).value.trim(),
            ports: $('[data-ports]', root).value.split(',').map((p) => Number(p.trim())).filter(Boolean),
          };
          ({ found } = await api('/api/discover', { method: 'POST', body }));
          chosen.clear();
          results.innerHTML = found.length
            ? found.map((info, i) => `
                <button class="browse-item" data-i="${i}">
                  <span class="dot bg-ios-green"></span>
                  <span class="min-w-0 flex-1">
                    <span class="font-mono">${esc(info.host)}:${info.port}</span>
                    <span class="ml-2 text-[11px] text-ios-gray">${esc(info.gpu)} · ${info.vramTotalGb} GB · ComfyUI ${esc(info.comfyuiVersion)}</span>
                  </span>
                </button>`).join('')
            : `<p class="p-6 text-center text-[12px] text-ios-gray">Nothing answered.<br />
                 Check that ComfyUI listens on 0.0.0.0 and the firewall allows the port.</p>`;
        } catch (err) {
          results.innerHTML = `<p class="p-6 text-center text-[12px] text-ios-red">${esc(err.message)}</p>`;
        } finally {
          button.disabled = false;
          button.textContent = 'Scan';
        }
      };

      results.addEventListener('click', (event) => {
        const item = event.target.closest('[data-i]');
        if (!item) return;
        const i = Number(item.dataset.i);
        item.classList.toggle('picked');
        if (chosen.has(i)) chosen.delete(i);
        else chosen.add(i);
      });

      $('[data-close]', root).onclick = close;
      $('[data-ok]', root).onclick = () => {
        let added = 0;
        for (const i of chosen) {
          const info = found[i];
          if (state.config.machines.some((m) => m.host === info.host && m.port === info.port)) continue;
          state.config.machines.push({
            name: `GPU-${String(state.config.machines.length + 1).padStart(2, '0')}`,
            host: info.host, port: info.port, slots: 2, enabled: true, note: info.gpu,
          });
          added += 1;
        }
        close();
        renderMachines();
        if (added) { saveFleet(true); toast(`Added ${added} machine${added === 1 ? '' : 's'}`, 'good'); }
      };

      $('[data-range]', root).focus();
    },
  });
}

/* ──────────────────────────────── run bar ───────────────────────────────── */

function jobPayload() {
  return {
    name: state.workflow ? state.workflow.name.replace(/\.json$/i, '') : 'job',
    workflow: state.workflow?.path,
    assets: state.assets,
    mode: $('input[name="mode"]:checked').value,
    count: Number($('#count').value) || 1,
    seed: seedValue(),
    overrides: state.overrides,
    machines: state.config.machines.filter((m) => m.enabled).map((m) => m.name),
    preflight: $('#preflight').checked,
    collect: {
      enabled: $('#collect-enabled').checked,
      destination: $('#destination').value.trim(),
      layout: $('#layout').value,
      overwrite: $('#overwrite').checked,
    },
  };
}

function seedValue() {
  const mode = $('#seed-mode .seg-item[aria-selected="true"]').dataset.seed;
  if (mode === 'random') return 'random';
  if (mode === 'keep') return 'keep';
  return Number($('#seed-value').value) || 0;
}

function guard() {
  if (!state.workflow) {
    selectTab('workflow');
    toast('Choose a workflow first', 'error');
    return false;
  }
  if (!state.config.machines.some((m) => m.enabled)) {
    selectTab('machines');
    toast('Switch on at least one machine', 'error');
    return false;
  }
  return true;
}

async function doCheck() {
  if (!guard()) return;
  showLog(true);
  try {
    await api('/api/check', { method: 'POST', body: jobPayload() });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doRun() {
  if (!guard()) return;
  showLog(true);
  try {
    await api('/api/run', { method: 'POST', body: jobPayload() });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doStop() {
  try {
    await api('/api/cancel', { method: 'POST', body: {} });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setBusy(busy, kind) {
  state.busy = busy;
  state.kind = kind;
  $('[data-action="run"]').disabled = busy;
  $('[data-action="check"]').disabled = busy;
  $('[data-action="stop"]').classList.toggle('hidden', !(busy && kind === 'run'));
  if (!busy) renderMachines();
}

function renderProgress(progress) {
  state.progress = progress;
  const { total = 0, done = 0, failed = 0, files = 0 } = progress || {};
  const bar = $('#progress-bar');
  const pct = total ? ((done + failed) / total) * 100 : 0;
  bar.style.width = `${pct}%`;
  bar.classList.toggle('fail', failed > 0 && done === 0);
  bar.classList.toggle('done', pct >= 100 && failed === 0);
  $('#progress-text').textContent = total
    ? `${done}/${total} done · ${failed} failed · ${files} files`
    : state.busy ? 'Working…' : 'Idle';

  $('#machine-chips').innerHTML = (progress?.machines || [])
    .map((m) => {
      const cls = m.state === 'offline' ? 'pill-red' : m.state === 'refused' ? 'pill-orange' : m.busy ? 'pill-blue' : 'pill-green';
      const label = m.state === 'offline' ? 'dropped' : m.state === 'refused' ? 'refused' : m.busy ? `${m.busy} running` : 'idle';
      return `<span class="pill ${cls}">${esc(m.name)} · ${label}</span>`;
    })
    .join('');
  renderMachines();
}

/* ───────────────────────────────── log ──────────────────────────────────── */

function logClass(line) {
  const text = line.trim();
  if (text.startsWith('!') || text.startsWith('x') || text.startsWith('error') || text.startsWith('run failed')) return 'log-err';
  if (text.startsWith('+') || text.startsWith('Done')) return 'log-ok';
  if (text.startsWith('[') || text.startsWith('===')) return 'log-info';
  if (text.startsWith('override') || text.startsWith('hint')) return 'log-dim';
  return '';
}

function appendLog(line) {
  const el = $('#log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const row = document.createElement('div');
  row.className = logClass(line);
  row.textContent = line || ' ';
  el.append(row);
  while (el.childElementCount > 3000) el.firstElementChild.remove();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function showLog(show) {
  $('#log-wrap').classList.toggle('hidden', !show);
  $('#log-toggle-text').textContent = show ? 'Hide log' : 'Show log';
  $('#log-chevron').style.transform = show ? 'rotate(180deg)' : '';
  if (show) $('#log').scrollTop = $('#log').scrollHeight;
}

/* ─────────────────────────────── last run ───────────────────────────────── */

function renderLastRun(manifest) {
  const box = $('#last-run');
  if (!manifest) return box.classList.add('hidden');
  box.classList.remove('hidden');
  const ok = manifest.tasksFailed === 0;
  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="flex items-center gap-2">
          <span class="pill ${ok ? 'pill-green' : 'pill-orange'}">${ok ? 'Finished' : 'Finished with problems'}</span>
          <h2 class="card-title">${esc(manifest.runId)}</h2>
        </div>
        <p class="card-sub">${manifest.tasksSucceeded}/${manifest.tasksTotal} tasks ok ·
          ${manifest.tasksFailed} failed · ${manifest.filesCollected} file(s) gathered ·
          ${manifest.elapsedSeconds}s</p>
      </div>
      <div class="px-4 pb-4">
        <div class="flex items-center gap-2 rounded-xl bg-black/4 dark:bg-white/6 p-3">
          <span class="min-w-0 flex-1 truncate font-mono text-[11px]">${esc(manifest.collectRoot)}</span>
          <button class="btn-tiny" data-action="open-destination">Open folder</button>
        </div>
      </div>
    </div>`;
}

/* ──────────────────────────── events / actions ──────────────────────────── */

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  const actions = {
    'add-machine': () => machineDialog(null),
    discover: discoverDialog,
    'refresh-status': refreshStatus,
    'save-fleet': () => saveFleet(),
    'browse-workflow': () =>
      browseDialog({
        title: 'Choose a workflow', extensions: ['.json'], start: state.workflow?.path,
        onPick: ([path]) => path && loadWorkflow({ path }),
      }),
    'add-asset-file': () =>
      browseDialog({
        title: 'Add input files', multiple: true,
        onPick: (paths) => { state.assets.push(...paths.filter((p) => !state.assets.includes(p))); renderAssets(); saveUi(); },
      }),
    'add-asset-folder': () =>
      browseDialog({
        title: 'Add a folder of input files', only: 'dirs',
        onPick: ([path]) => { if (path && !state.assets.includes(path)) state.assets.push(path); renderAssets(); saveUi(); },
      }),
    'add-override': () => overrideDialog(null),
    'browse-destination': () =>
      browseDialog({
        title: 'Where should the outputs go?', only: 'dirs', start: $('#destination').value.trim(),
        onPick: ([path]) => { if (path) { $('#destination').value = path; saveFleet(true); } },
      }),
    'open-destination': async () => {
      try {
        await api('/api/open', { method: 'POST', body: { path: $('#destination').value.trim() } });
      } catch (err) { toast(err.message, 'error'); }
    },
    'save-job': async () => {
      if (!guard()) return;
      try {
        const { path } = await api('/api/job', { method: 'POST', body: jobPayload() });
        toast(`Saved to ${fileName(path)}`, 'good');
      } catch (err) { toast(err.message, 'error'); }
    },
    'count-up': () => { $('#count').value = Number($('#count').value) + 1; saveUi(); },
    'count-down': () => { $('#count').value = Math.max(1, Number($('#count').value) - 1); saveUi(); },
    check: doCheck,
    run: doRun,
    stop: doStop,
    'toggle-log': () => showLog($('#log-wrap').classList.contains('hidden')),
  };
  actions[action]?.();
});

$$('input[name="mode"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    $('#count-label').textContent = radio.value === 'mirror' ? 'Runs per machine' : 'Total generations';
    saveUi();
  }));

['#count', '#seed-value', '#destination', '#layout', '#collect-enabled', '#overwrite', '#preflight'].forEach((sel) =>
  $(sel).addEventListener('change', () => {
    saveUi();
    if (['#destination', '#layout', '#collect-enabled', '#overwrite'].includes(sel)) saveFleet(true);
  }));

/* ──────────────────────────── state persistence ─────────────────────────── */

let saveTimer = null;
function saveUi() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('/api/ui', {
      method: 'PUT',
      body: {
        workflow: state.workflow?.path || '',
        assets: state.assets,
        overrides: state.overrides,
        mode: $('input[name="mode"]:checked').value,
        count: Number($('#count').value) || 1,
        seedMode: $('#seed-mode .seg-item[aria-selected="true"]').dataset.seed,
        seedValue: Number($('#seed-value').value) || 0,
        preflight: $('#preflight').checked,
      },
    }).catch(() => {});
  }, 400);
}

/* ────────────────────────────────── boot ────────────────────────────────── */

async function boot() {
  let data;
  try {
    data = await api('/api/state');
  } catch (err) {
    return toast(`Cannot reach the ComfyFleet server: ${err.message}`, 'error');
  }
  if (data.configError) toast(data.configError, 'error');

  state.config = data.config;
  const ui = data.ui || {};
  state.assets = ui.assets || [];
  state.overrides = ui.overrides || [];

  $('#destination').value = data.config.collect.destination || '';
  $('#layout').value = data.config.collect.layout || '{run_id}/{machine}/{filename}';
  $('#collect-enabled').checked = data.config.collect.enabled !== false;
  $('#overwrite').checked = !!data.config.collect.overwrite;
  $('#preflight').checked = ui.preflight !== false;
  $('#count').value = ui.count || 10;
  $('#seed-value').value = ui.seedValue || 0;

  const mode = $(`input[name="mode"][value="${ui.mode || 'shard'}"]`);
  if (mode) { mode.checked = true; mode.dispatchEvent(new Event('change')); }
  const seedItem = $(`#seed-mode .seg-item[data-seed="${ui.seedMode || 'random'}"]`);
  if (seedItem) seedItem.click();

  renderMachines();
  renderAssets();
  renderOverrides();

  if (ui.workflow) {
    try {
      state.workflow = await api('/api/workflow', { method: 'POST', body: { path: ui.workflow } });
    } catch {
      state.workflow = null; // the file moved or was deleted since last time
    }
  }
  renderWorkflow();

  for (const entry of data.log || []) appendLog(entry.line);
  setBusy(data.busy, data.kind);
  if (data.progress) renderProgress(data.progress);
  selectTab(localStorage.getItem('cf-tab') || 'machines');

  connectEvents();
  refreshStatus();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'log') appendLog(data.line);
    else if (data.type === 'progress') renderProgress(data);
    else if (data.type === 'busy') setBusy(data.busy, data.kind);
    else if (data.type === 'done') {
      renderLastRun(data.manifest);
      if (data.manifest) {
        const ok = data.manifest.tasksFailed === 0;
        toast(
          ok ? `Finished — ${data.manifest.filesCollected} file(s) gathered`
             : `Finished with ${data.manifest.tasksFailed} failed task(s)`,
          ok ? 'good' : 'error',
        );
      }
      refreshStatus();
    } else if (data.type === 'check') {
      const bad = data.reports.filter((r) => !r.ok).length;
      toast(bad ? `${bad} machine(s) not ready — see the log` : 'All machines ready', bad ? 'error' : 'good');
      state.status = new Map(
        data.reports.map((r) => [r.machine, {
          online: r.reachable, gpu: r.gpu, comfyuiVersion: r.comfyuiVersion,
          vramFreeGb: state.status.get(r.machine)?.vramFreeGb ?? 0,
          queue: state.status.get(r.machine)?.queue ?? 0, error: r.error,
        }]),
      );
      renderMachines();
    }
  };
  source.onerror = () => { /* EventSource reconnects on its own */ };
}

boot();
