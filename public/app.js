/* ComfyFleet web UI - vanilla JS, no framework. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: { fleet: {}, collect: {}, machines: [] },
  status: new Map(), // machine name -> ping result
  // every workflow in the job: { id, name, path, info, assets[], overrides[] }
  workflows: [],
  selected: null, // id of the workflow whose files/overrides/nodes are shown
  assignments: {}, // machine name -> workflow id
  counts: {},      // machine name -> generations (blank = use the default below)
  defaultCount: 10,
  fleet: null,     // live worker state pushed from the server
  nativeDialogs: true, // false when the server has no desktop: upload from the browser
  busy: false,     // a machine check is running
  kind: null,
  expandedNodes: new Set(),
};

let nextWorkflowId = 1;
const newWorkflowId = () => `w${nextWorkflowId++}`;

const selectedWorkflow = () => state.workflows.find((w) => w.id === state.selected) || null;
const workflowById = (id) => state.workflows.find((w) => w.id === id) || null;

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

async function api(path, { method = 'GET', body, raw } = {}) {
  const response = await fetch(path, {
    method,
    ...(raw !== undefined ? { body: raw } : {}),
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
  const live = state.fleet?.machines?.find((m) => m.name === machine.name);
  const count = state.counts[machine.name] ?? '';

  // Live worker state wins over the last ping, because it is what the machine is doing now.
  let pill = '<span class="pill">not checked</span>';
  if (live && live.status === 'running') {
    pill = `<span class="pill pill-blue"><span class="dot bg-ios-blue dot-pulse"></span>rendering ${live.running}</span>`;
  } else if (live && live.status === 'paused') {
    pill = '<span class="pill pill-orange">paused</span>';
  } else if (live && live.status === 'offline') {
    pill = '<span class="pill pill-red"><span class="dot bg-ios-red"></span>not answering</span>';
  } else if (info) {
    pill = info.online
      ? '<span class="pill pill-green"><span class="dot bg-ios-green"></span>online</span>'
      : '<span class="pill pill-red"><span class="dot bg-ios-red"></span>offline</span>';
  }

  const detail = info?.online
    ? `${esc(info.gpu)} · ${info.vramFreeGb} GB free · ComfyUI ${esc(info.comfyuiVersion)}`
    : info?.error
      ? esc(info.error)
      : machine.note
        ? esc(machine.note)
        : 'Press “Refresh status” to see this machine’s GPU';

  const busy = live && (live.queued || live.running);
  const tally = live && (live.done || live.failed || live.cancelled || live.queued || live.running)
    ? `<span class="pill">${live.done} done${live.failed ? ` · ${live.failed} failed` : ''}` +
      `${live.cancelled ? ` · ${live.cancelled} cancelled` : ''}` +
      `${live.queued ? ` · ${live.queued} queued` : ''}${live.files ? ` · ${live.files} files` : ''}</span>`
    : '';

  const controls = `
    <button class="btn-tiny" data-start="${esc(machine.name)}" title="Start this machine only">Start</button>
    ${live?.status === 'paused'
      ? `<button class="btn-tiny" data-resume="${esc(machine.name)}">Resume</button>`
      : `<button class="btn-tiny" data-pause="${esc(machine.name)}" ${busy ? '' : 'disabled'}>Pause</button>`}
    <button class="btn-tiny danger" data-stop="${esc(machine.name)}" ${busy ? '' : 'disabled'}>Stop</button>`;

  return `
    <div class="card">
      <div class="flex flex-wrap items-center gap-3 p-4">
        <input type="checkbox" class="ios-switch small" data-toggle="${index}" ${machine.enabled ? 'checked' : ''}
               title="Include this machine when starting everything" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[14px] font-semibold">${esc(machine.name)}</span>
            <span class="font-mono text-[12px] text-ios-gray">${esc(machine.host)}:${machine.port}</span>
            ${pill}${tally}
          </div>
          <p class="mt-0.5 truncate text-[12px] text-ios-gray">${live?.note ? esc(live.note) : detail}</p>
        </div>
        <div class="flex items-center gap-1.5">
          ${assignPicker(machine)}
          <input type="number" min="1" class="field !py-1.5 !text-[12px] w-20" data-count-for="${esc(machine.name)}"
                 value="${esc(count)}" placeholder="${state.defaultCount}" title="Generations for this machine" />
          <button class="btn-tiny" data-edit="${index}">Edit</button>
          <button class="btn-tiny danger" data-remove="${index}">Remove</button>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 border-t border-black/6 dark:border-white/8 px-4 py-2">
        ${controls}
        ${live && live.status !== 'idle' ? `<span class="ml-auto text-[11px] text-ios-gray">${esc(live.status)}</span>` : ''}
      </div>
    </div>`;
}

/** Which workflow this machine runs. Hidden until there is something to choose. */
function assignPicker(machine) {
  if (!state.workflows.length) return '';
  const current = state.assignments[machine.name] || '';
  const options = [
    `<option value=""${current ? '' : ' selected'}>— no workflow —</option>`,
    ...state.workflows.map(
      (w) => `<option value="${esc(w.id)}"${w.id === current ? ' selected' : ''}>${esc(w.name)}</option>`,
    ),
  ].join('');
  return `<select class="field !py-1.5 !text-[12px] max-w-[12rem]" data-assign="${esc(machine.name)}"
                  title="Workflow this machine runs">${options}</select>`;
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

$('#machine-list').addEventListener('click', async (event) => {
  // per-machine controls: each one acts on that machine alone
  const start = event.target.closest('[data-start]');
  const pause = event.target.closest('[data-pause]');
  const resume = event.target.closest('[data-resume]');
  const stopIt = event.target.closest('[data-stop]');
  try {
    if (start) return await startWork([start.dataset.start]);
    if (pause) return await machineAction(pause.dataset.pause, 'pause');
    if (resume) return await machineAction(resume.dataset.resume, 'resume');
    if (stopIt) return await machineAction(stopIt.dataset.stop, 'stop');
  } catch (err) {
    return toast(err.message, 'error');
  }

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

async function machineAction(machine, action) {
  const data = await api('/api/machine', { method: 'POST', body: { machine, action } });
  if (data.fleet) applyFleet(data.fleet);
}

$('#machine-list').addEventListener('change', (event) => {
  const count = event.target.closest('[data-count-for]');
  if (count) {
    const machine = count.dataset.countFor;
    const value = Math.floor(Number(count.value));
    if (value >= 1) state.counts[machine] = value;
    else delete state.counts[machine];
    saveUi();
    return;
  }
  const assign = event.target.closest('[data-assign]');
  if (assign) {
    const machine = assign.dataset.assign;
    if (assign.value) state.assignments[machine] = assign.value;
    else delete state.assignments[machine];
    renderWorkflows();
    saveUi();
    return;
  }
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

function renderWorkflows() {
  const list = $('#workflow-list');
  const zone = $('#drop-zone');
  const panels = $('#selected-panels');

  zone.classList.toggle('hidden', state.workflows.length > 0);
  panels.classList.toggle('hidden', !state.workflows.length);

  if (!state.workflows.length) {
    list.innerHTML = '';
    state.selected = null;
    $('#node-tree').innerHTML =
      '<p class="px-3 py-6 text-center text-[12px] text-ios-gray">Add a workflow to see its nodes.</p>';
    renderMachines();
    return;
  }

  if (!workflowById(state.selected)) state.selected = state.workflows[0].id;

  list.innerHTML = state.workflows
    .map((wf) => {
      const chosen = wf.id === state.selected;
      const machines = Object.entries(state.assignments)
        .filter(([, id]) => id === wf.id)
        .map(([machine]) => machine);
      const info = wf.info;
      const chips = info
        ? `${info.nodeCount} nodes · ${info.seedWidgets} seed${info.seedWidgets === 1 ? '' : 's'}` +
          `${wf.assets.length ? ` · ${wf.assets.length} input file${wf.assets.length === 1 ? '' : 's'}` : ''}` +
          `${wf.overrides.length ? ` · ${wf.overrides.length} override${wf.overrides.length === 1 ? '' : 's'}` : ''}`
        : 'could not be read';
      return `
        <div class="rounded-xl border ${chosen ? 'border-ios-blue bg-ios-blue/8' : 'border-black/8 dark:border-white/10 bg-black/3 dark:bg-white/5'}
                    p-3 transition cursor-pointer" data-pick-workflow="${esc(wf.id)}">
          <div class="flex items-center gap-3">
            <div class="grid size-9 flex-none place-items-center rounded-[9px] ${chosen ? 'bg-ios-blue/20' : 'bg-black/6 dark:bg-white/10'}">
              <svg class="size-5 ${chosen ? 'fill-ios-blue' : 'fill-current opacity-50'}" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 2 4 4h-4V4Z"/></svg>
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-semibold">${esc(wf.name)}</p>
              <p class="truncate text-[11px] text-ios-gray">${esc(chips)}</p>
            </div>
            <button class="btn-tiny" data-assign-all="${esc(wf.id)}" title="Run this on every machine">All machines</button>
            <button class="btn-tiny danger" data-remove-workflow="${esc(wf.id)}">Remove</button>
          </div>
          ${machines.length
            ? `<p class="mt-2 flex flex-wrap gap-1.5">${machines.map((m) => `<span class="pill pill-blue">${esc(m)}</span>`).join('')}</p>`
            : '<p class="mt-2 text-[11px] text-ios-orange">not assigned to any machine yet</p>'}
        </div>`;
    })
    .join('');

  for (const el of $$('[data-selected-name]')) el.textContent = selectedWorkflow()?.name || '';
  renderNodeTree();
  renderAssets();
  renderOverrides();
  renderMachines();
}

$('#workflow-list').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-workflow]');
  if (remove) {
    event.stopPropagation();
    const id = remove.dataset.removeWorkflow;
    const wf = workflowById(id);
    state.workflows = state.workflows.filter((w) => w.id !== id);
    for (const [machine, assigned] of Object.entries(state.assignments)) {
      if (assigned === id) delete state.assignments[machine];
    }
    if (state.selected === id) state.selected = state.workflows[0]?.id || null;
    renderWorkflows();
    saveUi();
    toast(`Removed ${wf?.name || 'workflow'}`);
    return;
  }
  const assignAll = event.target.closest('[data-assign-all]');
  if (assignAll) {
    event.stopPropagation();
    const id = assignAll.dataset.assignAll;
    for (const machine of state.config.machines) state.assignments[machine.name] = id;
    renderWorkflows();
    saveUi();
    toast(`Every machine will run ${workflowById(id)?.name}`, 'good');
    return;
  }
  const pick = event.target.closest('[data-pick-workflow]');
  if (pick && pick.dataset.pickWorkflow !== state.selected) {
    state.selected = pick.dataset.pickWorkflow;
    state.expandedNodes = new Set();
    renderWorkflows();
    saveUi();
  }
});

function renderNodeTree() {
  const tree = $('#node-tree');
  const wf = selectedWorkflow();
  if (!wf?.info) {
    tree.innerHTML = '<p class="px-3 py-6 text-center text-[12px] text-ios-gray">Add a workflow to see its nodes.</p>';
    return;
  }
  tree.innerHTML = wf.info.outline
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

/** Add a workflow to the job (or refresh one that is already there). */
async function loadWorkflow(payload, { replaceId = null } = {}) {
  let info;
  try {
    info = await api('/api/workflow', { method: 'POST', body: payload });
  } catch (err) {
    return toast(err.message, 'error');
  }

  const existing = replaceId
    ? workflowById(replaceId)
    : state.workflows.find((w) => w.path.toLowerCase() === info.path.toLowerCase());

  if (existing) {
    existing.info = info;
    existing.name = info.name.replace(/\.json$/i, '');
    existing.path = info.path;
    state.selected = existing.id;
    toast(`Reloaded ${existing.name}`, 'good');
  } else {
    const entry = {
      id: newWorkflowId(),
      name: info.name.replace(/\.json$/i, ''),
      path: info.path,
      info,
      assets: [],
      overrides: [],
    };
    state.workflows.push(entry);
    state.selected = entry.id;
    // First one added? Nothing is assigned yet, so put it on every machine - the common case.
    if (state.workflows.length === 1) {
      for (const machine of state.config.machines) state.assignments[machine.name] = entry.id;
    }
    toast(`Added ${entry.name}`, 'good');
  }
  state.expandedNodes = new Set();
  renderWorkflows();
  saveUi();
}

// drag and drop workflow json files onto the page
const zone = $('#drop-zone');
['dragenter', 'dragover'].forEach((type) =>
  zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) =>
  zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('dragging'); }));
document.addEventListener('dragover', (e) => e.preventDefault());
/**
 * Drop anything onto the page: .json files become workflows, everything else is
 * uploaded to the server as an input file for the selected workflow. This is the path
 * that matters when ComfyFleet runs on a server somewhere else - the browser sends the
 * bytes, and the server feeds them to the machines from there.
 */
document.addEventListener('drop', async (event) => {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();

  const workflows = files.filter((f) => f.name.toLowerCase().endsWith('.json'));
  const assets = files.filter((f) => !f.name.toLowerCase().endsWith('.json'));

  for (const file of workflows) {
    try {
      await loadWorkflow({ name: file.name, data: JSON.parse(await file.text()) });
    } catch {
      toast(`${file.name} is not valid JSON`, 'error');
    }
  }
  if (assets.length) await uploadInputFiles(assets);
});

/** Send files to the server and attach them to the selected workflow. */
async function uploadInputFiles(files) {
  const wf = selectedWorkflow();
  if (!wf) {
    selectTab('workflow');
    return toast('Add a workflow first, then its input files', 'error');
  }
  let added = 0;
  for (const file of files) {
    const size = file.size > 1024 ** 2 ? `${(file.size / 1024 ** 2).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`;
    toast(`Uploading ${file.name} (${size})…`);
    try {
      const result = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file });
      if (!wf.assets.includes(result.path)) {
        wf.assets.push(result.path);
        added += 1;
      }
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'error');
    }
  }
  if (added) {
    renderWorkflows();
    saveUi();
    toast(`Added ${added} input file${added === 1 ? '' : 's'} to ${wf.name}`, 'good');
  }
}

/* ──────────────────────────────── assets ─────────────────────────────────── */

function renderAssets() {
  const list = $('#asset-list');
  const wf = selectedWorkflow();
  const assets = wf?.assets || [];
  $('#clear-assets')?.classList.toggle('hidden', !assets.length);
  if (!assets.length) {
    list.innerHTML = '<p class="px-4 pb-1 pt-0 text-[12px] text-ios-gray">Nothing added. Only needed if the workflow loads a video, image or audio file.</p>';
  } else {
    list.innerHTML = assets
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
  const wf = selectedWorkflow();
  if (!wf?.info?.assetRefs?.length) return;
  const have = new Set((wf.assets || []).map((a) => fileName(a).toLowerCase()));
  const missing = wf.info.assetRefs.filter((ref) => !have.has(fileName(ref).toLowerCase()));
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
  selectedWorkflow()?.assets.splice(Number(remove.dataset.removeAsset), 1);
  renderWorkflows();
  saveUi();
});

/* ─────────────────────────────── overrides ───────────────────────────────── */

function renderOverrides() {
  const list = $('#override-list');
  const overrides = selectedWorkflow()?.overrides || [];
  if (!overrides.length) {
    list.innerHTML = '<p class="px-4 pb-1 text-[12px] text-ios-gray">None. Tap a setting in the node list to override it.</p>';
    return;
  }
  list.innerHTML = overrides
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
    selectedWorkflow()?.overrides.splice(Number(remove.dataset.removeOverride), 1);
    renderWorkflows();
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
        if (index === null) {
          state.config.machines.push(updated);
          if (state.workflows.length === 1) state.assignments[updated.name] = state.workflows[0].id;
        } else {
          const previous = state.config.machines[index].name;
          if (previous !== updated.name && state.assignments[previous]) {
            state.assignments[updated.name] = state.assignments[previous];
            delete state.assignments[previous];
          }
          state.config.machines[index] = updated;
        }
        close();
        renderMachines();
        saveFleet(true);
      };
    },
  });
}

function overrideDialog(index = null, prefill = null) {
  const list = selectedWorkflow()?.overrides || [];
  const existing = index === null ? null : list[index];
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
        if (index === null) list.push(override);
        else list[index] = override;
        close();
        renderWorkflows();
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

/* ────────────────────────── native file dialogs ─────────────────────────── */

/**
 * Opens the real Explorer dialog on the machine running ComfyFleet.
 * If that is not possible (headless box, or the UI opened from another computer)
 * it falls back to typing a path.
 */
async function choosePaths({ kind = 'file', filter = 'any', initial = '', title = 'Select' }) {
  let result;
  const button = document.activeElement;
  if (button?.tagName === 'BUTTON') button.disabled = true;
  try {
    result = await api('/api/pick', { method: 'POST', body: { kind, filter, initial, title } });
  } catch (err) {
    toast(err.message, 'error');
    return [];
  } finally {
    if (button?.tagName === 'BUTTON') button.disabled = false;
  }
  if (result.unavailable) return typePathDialog({ kind, title, initial, reason: result.error });
  return result.paths || [];
}

function typePathDialog({ kind, title, initial, reason }) {
  return new Promise((resolve) => {
    let settled = false;
    openSheet({
      title,
      subtitle: `The file dialog could not be opened${reason ? ` (${reason})` : ''}. Type the full path instead — it must be a path the machine running ComfyFleet can reach.`,
      width: '34rem',
      body: `<div class="pb-2"><input class="field w-full font-mono text-[12px]" data-path
                value="${esc(initial || '')}" spellcheck="false"
                placeholder="${kind === 'folder' ? '\\\\SERVER\\share\\folder' : 'D:\\\\path\\\\to\\\\file'}" /></div>`,
      footer: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" data-ok>Use this</button>',
      onMount: (root, close) => {
        const input = $('[data-path]', root);
        const done = (value) => { settled = true; close(); resolve(value ? [value] : []); };
        $('[data-close]', root).onclick = () => done(null);
        $('[data-ok]', root).onclick = () => done(input.value.trim());
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); });
        root.addEventListener('remove', () => { if (!settled) resolve([]); });
        input.focus();
      },
    });
  });
}

/* ───────────────────────────── discover dialog ──────────────────────────── */

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

/**
 * @param only  machine names to start; empty means every enabled machine that has a workflow
 */
function jobPayload(only = null) {
  const machines = (only && only.length
    ? state.config.machines.filter((m) => only.includes(m.name))
    : state.config.machines.filter((m) => m.enabled)
  ).map((m) => m.name);

  return {
    name: state.workflows.length === 1 ? state.workflows[0].name : 'fleet-job',
    workflows: state.workflows.map((w) => ({
      id: w.id, name: w.name, path: w.path, assets: w.assets, overrides: w.overrides,
    })),
    assignments: Object.fromEntries(
      Object.entries(state.assignments).filter(([machine, id]) => workflowById(id) && machines.includes(machine)),
    ),
    // each machine can ask for its own number of generations; blank falls back to the default
    counts: Object.fromEntries(machines.map((m) => [m, state.counts[m] || state.defaultCount])),
    count: state.defaultCount,
    seed: seedValue(),
    machines,
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

function guard(only = null) {
  if (!state.workflows.length) {
    selectTab('workflow');
    toast('Add a workflow first', 'error');
    return false;
  }
  const candidates = only && only.length
    ? state.config.machines.filter((m) => only.includes(m.name))
    : state.config.machines.filter((m) => m.enabled);
  if (!candidates.length) {
    selectTab('machines');
    toast('Switch on at least one machine', 'error');
    return false;
  }
  if (!candidates.some((m) => workflowById(state.assignments[m.name]))) {
    selectTab('machines');
    toast(only ? `Give ${only[0]} a workflow first` : 'Assign a workflow to at least one machine', 'error');
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

/** Queue work. Machines already rendering carry on; this only adds to the ones named. */
async function startWork(only = null) {
  if (!guard(only)) return;
  showLog(true);
  try {
    const data = await api('/api/run', { method: 'POST', body: jobPayload(only) });
    const queued = (data.batches || []).reduce((sum, b) => sum + b.total, 0);
    if (queued) toast(`Queued ${queued} generation${queued === 1 ? '' : 's'}`, 'good');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doStopAll() {
  try {
    const data = await api('/api/cancel', { method: 'POST', body: {} });
    if (data.fleet) applyFleet(data.fleet);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setBusy(busy, kind) {
  state.busy = busy;
  state.kind = kind;
  $('[data-action="check"]').disabled = busy;
}

/** Draw the live worker state: totals in the dock, per-machine detail in the list. */
function applyFleet(snapshot) {
  state.fleet = snapshot;
  const machines = snapshot?.machines || [];
  const totals = machines.reduce(
    (acc, m) => ({
      done: acc.done + m.done, failed: acc.failed + m.failed, cancelled: acc.cancelled + (m.cancelled || 0),
      queued: acc.queued + m.queued, running: acc.running + m.running, files: acc.files + m.files,
    }),
    { done: 0, failed: 0, cancelled: 0, queued: 0, running: 0, files: 0 },
  );
  const outstanding = totals.queued + totals.running;
  const total = totals.done + totals.failed + totals.cancelled + outstanding;

  const bar = $('#progress-bar');
  const pct = total ? ((totals.done + totals.failed) / total) * 100 : 0;
  bar.style.width = `${pct}%`;
  bar.classList.toggle('fail', totals.failed > 0 && totals.done === 0);
  bar.classList.toggle('done', total > 0 && !outstanding && !totals.failed);
  $('#progress-text').textContent = total
    ? `${totals.done}/${total} done${totals.failed ? ` · ${totals.failed} failed` : ''}` +
      `${totals.cancelled ? ` · ${totals.cancelled} cancelled` : ''} · ${totals.files} files`
    : 'Idle';

  $('[data-action="stop"]').classList.toggle('hidden', !outstanding);

  $('#machine-chips').innerHTML = machines
    .filter((m) => m.status !== 'idle' || m.queued || m.running)
    .map((m) => {
      const cls = m.status === 'offline' ? 'pill-red' : m.status === 'paused' ? 'pill-orange'
        : m.running ? 'pill-blue' : 'pill-green';
      const label = m.status === 'offline' ? 'not answering'
        : m.status === 'paused' ? `paused · ${m.queued} waiting`
        : m.running ? `${m.running} rendering${m.queued ? ` · ${m.queued} queued` : ''}`
        : 'idle';
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
    'browse-workflow': async () => {
      // multi-select: several workflows can be added in one go
      const chosen = await choosePaths({
        kind: 'files', filter: 'workflow', title: 'Add API workflows',
        initial: selectedWorkflow()?.path || '',
      });
      for (const file of chosen) await loadWorkflow({ path: file });
    },

    'upload-asset-file': () => $('#file-input').click(),
    'add-asset-file': async () => {
      if (!state.nativeDialogs) return $('#file-input').click(); // headless server: upload instead
      const paths = await choosePaths({ kind: 'files', filter: 'media', title: 'Add input files' });
      const wf = selectedWorkflow();
      if (!wf) return;
      const added = paths.filter((p) => !wf.assets.includes(p));
      wf.assets.push(...added);
      renderWorkflows();
      saveUi();
      if (added.length) toast(`Added ${added.length} file${added.length === 1 ? '' : 's'}`, 'good');
    },
    'add-asset-folder': async () => {
      const [chosen] = await choosePaths({ kind: 'folder', title: 'Add a folder of input files' });
      const wf = selectedWorkflow();
      if (wf && chosen && !wf.assets.includes(chosen)) {
        wf.assets.push(chosen);
        renderWorkflows();
        saveUi();
      }
    },
    'clear-assets': () => {
      const wf = selectedWorkflow();
      if (!wf) return;
      wf.assets = [];
      renderWorkflows();
      saveUi();
    },
    'add-override': () => overrideDialog(null),
    'browse-destination': async () => {
      const [chosen] = await choosePaths({
        kind: 'folder', title: 'Where should the outputs go?', initial: $('#destination').value.trim(),
      });
      if (chosen) {
        $('#destination').value = chosen;
        saveFleet(true);
      }
    },
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
    'count-up': () => { $('#count').value = Number($('#count').value) + 1; state.defaultCount = Number($('#count').value); renderMachines(); saveUi(); },
    'count-down': () => { $('#count').value = Math.max(1, Number($('#count').value) - 1); state.defaultCount = Number($('#count').value); renderMachines(); saveUi(); },
    check: doCheck,
    run: () => startWork(),
    stop: doStopAll,
    'toggle-log': () => showLog($('#log-wrap').classList.contains('hidden')),
  };
  actions[action]?.();
});



['#count', '#seed-value', '#destination', '#layout', '#collect-enabled', '#overwrite', '#preflight'].forEach((sel) =>
  $(sel).addEventListener('change', () => {
    saveUi();
    if (['#destination', '#layout', '#collect-enabled', '#overwrite'].includes(sel)) saveFleet(true);
  }));

$('#file-input').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = ''; // so picking the same file twice still fires
  if (files.length) await uploadInputFiles(files);
});

/* ──────────────────────────── state persistence ─────────────────────────── */

let saveTimer = null;
function saveUi() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('/api/ui', {
      method: 'PUT',
      body: {
        workflows: state.workflows.map((w) => ({
          id: w.id, name: w.name, path: w.path, assets: w.assets, overrides: w.overrides,
        })),
        selected: state.selected,
        assignments: state.assignments,
        counts: state.counts,
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
  state.nativeDialogs = data.nativeDialogs !== false;
  if (data.version) {
    const badge = $('#version');
    if (badge) badge.textContent = `v${data.version}`;
  }
  const ui = data.ui || {};
  state.assignments = ui.assignments || {};

  $('#destination').value = data.config.collect.destination || '';
  $('#layout').value = data.config.collect.layout || '{run_id}/{machine}/{filename}';
  $('#collect-enabled').checked = data.config.collect.enabled !== false;
  $('#overwrite').checked = !!data.config.collect.overwrite;
  $('#preflight').checked = ui.preflight !== false;
  state.defaultCount = Number(ui.count) || 10;
  state.counts = ui.counts || {};
  $('#count').value = state.defaultCount;
  $('#seed-value').value = ui.seedValue || 0;


  const seedItem = $(`#seed-mode .seg-item[data-seed="${ui.seedMode || 'random'}"]`);
  if (seedItem) seedItem.click();

  renderMachines();

  // Restore the workflow list. Anything whose file has moved since last time is dropped,
  // with a note, rather than failing the whole page.
  const saved = ui.workflows?.length ? ui.workflows : ui.workflow ? [{ path: ui.workflow }] : [];
  for (const entry of saved) {
    try {
      const info = await api('/api/workflow', { method: 'POST', body: { path: entry.path } });
      const id = entry.id || newWorkflowId();
      nextWorkflowId = Math.max(nextWorkflowId, Number(String(id).replace(/\D/g, '')) + 1 || nextWorkflowId);
      state.workflows.push({
        id,
        name: entry.name || info.name.replace(/\.json$/i, ''),
        path: info.path,
        info,
        assets: entry.assets || ui.assets || [],
        overrides: entry.overrides || ui.overrides || [],
      });
    } catch {
      toast(`${fileName(entry.path)} could not be opened - removed from the list`, 'error');
    }
  }
  state.selected = state.workflows.some((w) => w.id === ui.selected) ? ui.selected : state.workflows[0]?.id || null;
  renderWorkflows();

  for (const entry of data.log || []) appendLog(entry.line);
  setBusy(data.busy, data.kind);
  if (data.fleet) applyFleet(data.fleet);
  // #machines / #workflow / #output opens straight on that tab, so a link or a bookmark
  // can point at one; otherwise carry on where you left off.
  const fromHash = location.hash.replace('#', '');
  selectTab(['machines', 'workflow', 'output'].includes(fromHash)
    ? fromHash
    : localStorage.getItem('cf-tab') || 'machines');

  connectEvents();
  refreshStatus();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'log') appendLog(data.line);
    else if (data.type === 'fleet') applyFleet(data);
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
