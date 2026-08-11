# ComfyFleet

Run your ComfyUI workflows across every GPU workstation on the LAN from one browser tab, and
pull the outputs back to a single shared folder as they are produced.

```bash
npm start
```

Then open **http://localhost:8787**. There is nothing to install — no npm dependencies, no
build step. Node 20 or newer and the files in this folder are the whole thing.

It drives the HTTP API that every ComfyUI install already runs — Desktop, portable and manual
installs alike. Nothing has to be installed on the GPU machines themselves.

---

## The interface

Three tabs. Everything is saved, so it comes back the way you left it.

**1. Machines** — add each ComfyUI box by IP address and port, or press *Find on network* to
scan the subnet and pick from whatever answers. Each row carries that machine's own settings and
controls: which **workflow** it runs, how many **generations** to do, and **Start / Pause /
Resume / Stop** for that machine alone. The rows show live state while work is going — rendering,
queued, paused, not answering — plus a running tally of done, failed and files collected.

Machines work independently. Starting one does not touch the others, and you can add machines,
add workflows and start more work while a render is already in progress.

**2. Workflow** — hold **as many workflows as you like**. Drop the exported `.json` files onto
the page, or press *Add workflow* to open the normal Windows file dialog. Each one keeps its own
**input files** and **overrides**: select a workflow in the list and the panels below (and the
node inspector on the right) apply to it. Clicking any setting in the node list creates an
override for that workflow — prompt text, steps, cfg, resolution — without editing the file.
*All machines* puts one workflow on the whole fleet; *Remove* takes it out of the job.

**Assigning workflows to machines** — every machine row on the Machines tab has a workflow
picker. Give each machine a different workflow, or point them all at the same one. A machine
with no workflow assigned simply sits the run out. With a single workflow in the job and nothing
chosen, every machine runs it.

**3. Output** — where finished files are gathered: a LAN share such as
`\\FILESERVER\ComfyOutputs`, or any folder on this computer. *Save as job file* writes the whole
setup out so a script or scheduled task can run it later with `cf run <file>`.

The dock at the bottom stays put: *Check machines*, *Start all machines* (which honours each
machine's own count), *Stop everything*, a progress bar covering the whole fleet, a chip per busy
machine, and a live log streamed from the server.

Light and dark follow the system by default; the button in the header cycles auto → light → dark.

---

## What it does and does not do

**Does**

- Sends the exact same workflow graph (all nodes, wiring, widget values) to every machine.
- Uploads input assets (reference images, video, audio, masks) into each machine's `input/` folder.
- Overrides prompts and any other widget value per run, without editing the JSON.
- Gives every machine its own workflow, its own input files and its own number of generations.
- Runs machines independently: start, pause, resume or stop any one of them without disturbing
  the rest, and queue more work onto a machine that is already busy.
- Downloads every produced file (images, videos, audio — anything a save node emits) **the
  moment the machine writes it**, not at the end of the run: ComfyFleet listens on each
  machine's event socket, so a file is on the share while the rest of the graph is still
  running. Outputs are sorted per run, per workflow and per machine, with a `run.json` manifest
  recording seed, machine, workflow, prompt id and size for each.
- Runs a different workflow on each machine in the same run, each with its own input files.
- Survives a machine dropping out mid-run: its unfinished work is requeued to the others.
- Tells you *why* a machine cannot run something — a missing custom node, a missing model, or a
  missing input file — by name, before anything is queued.

**Does not**

- Split a *single* image or video across GPUs. One generation runs on one GPU; that is a
  ComfyUI/model limitation, not this tool's. The parallelism here is per-generation.
- Copy checkpoints, LoRAs, VAEs or custom node code. Those are gigabytes and live outside the
  API — `tools/Sync-Models.ps1` mirrors them from a master share.
- Install or launch ComfyUI. It must already be running on each machine.

---

## 1. Prepare each GPU machine (once)

By default ComfyUI listens on `127.0.0.1` only, so nothing outside that machine can reach it.

**a) Make the server listen on the network**

- *ComfyUI Desktop*: Settings (gear) → **Server-Config** → set **Listen** to `0.0.0.0`, note the
  **Port** (Desktop defaults to `8000`), restart ComfyUI Desktop.
- *Portable / manual*: launch with `python main.py --listen 0.0.0.0 --port 8188`.

**b) Open the port in Windows Firewall.** In an elevated PowerShell on that machine:

```bash
powershell -ExecutionPolicy Bypass -File tools\Enable-ComfyRemote.ps1 -Port 8000
```

It adds an inbound rule scoped to the local subnet and prints the machine's addresses.

> Only do this on a trusted internal network. The ComfyUI API has no authentication — anyone who
> can reach the port can queue jobs and read outputs. Keep the rule subnet-scoped and never
> forward these ports to the internet. The same applies to ComfyFleet's own web interface, which
> binds to localhost unless you pass `--host`.

**c) Give the machines fixed addresses.** DHCP reservations or host names both work.

---

## 2. Start ComfyFleet

On any PC on the LAN, including one of the GPU boxes:

```bash
npm start
```

To reach the interface from another machine on the network:

```bash
node bin/cf.js web --host 0.0.0.0 --port 8787
```

Then use *Find on network* on the Machines tab, or add machines by hand.

**File dialogs.** *Choose file*, *Add files* and *Browse* open the real Windows file dialog on
the machine running ComfyFleet — that is deliberate, since the paths have to make sense to the
server, not to your browser. If you drive the interface from a different computer, the dialog
would appear on the server's screen where nobody can see it, so start the server with
`COMFYFLEET_PICKER=off` and the interface will ask you to type paths instead. It falls back to
that automatically on a machine with no desktop.

---

## 3. Keep models and custom nodes in sync

A workflow only runs where its checkpoints, LoRAs and custom nodes exist. Keep one master copy
on a share and mirror it to each machine:

```bash
powershell -ExecutionPolicy Bypass -File tools\Sync-Models.ps1 -Source \\FILESERVER\ComfyMaster -Target "C:\Users\me\Documents\ComfyUI" -IncludeCustomNodes
```

Models must sit at the **same relative path** everywhere (`models/checkpoints/foo.safetensors`),
because that relative name is what the workflow stores. Custom nodes also need their Python
dependencies — after copying `custom_nodes`, open ComfyUI once on that machine and let ComfyUI
Manager install requirements.

*Alternative*: point every machine at the share with `extra_model_paths.yaml` instead of copying.
Simpler to maintain, but each model load then streams over the network — on 1 GbE a 6 GB
checkpoint costs about a minute the first time. Local copies are worth the disk.

**Check machines** in the interface verifies all of this and names anything missing.

---

## 4. Export the workflow

In ComfyUI: **Workflow → Export (API)**. This is not the same as Save — the API format is a flat
map of nodes with `class_type`, which is what the queue endpoint accepts. A normal saved workflow
is rejected with a message telling you so.

---

## Input files vs. models

If a workflow loads a video, reference image or audio clip, that file has to exist on every
machine. Add it under **Input files** on the Workflow tab and it is uploaded before each run.
Models are the opposite — too big for the API, so they are synced separately. Preflight tells you
which of the two is missing, by name, and lists what the machine does have instead.

---

## Command line

The same engine, for scripts and scheduled tasks:

| Command | Purpose |
|---|---|
| `node bin/cf.js web [--port 8787] [--host 0.0.0.0] [--open]` | Open the web interface |
| `node bin/cf.js status [--only A,B] [-v]` | Ping every machine: GPU, free VRAM, queue depth |
| `node bin/cf.js discover 192.168.1.0/24` | Scan the network and print config JSON |
| `node bin/cf.js check jobs/my-job.json` | Report missing nodes / models / inputs per machine |
| `node bin/cf.js run jobs/my-job.json` | Dispatch, monitor, collect |
| `node bin/cf.js cancel [--only A,B]` | Clear queues and interrupt running jobs |
| `node bin/cf.js free [--only A,B]` | Unload models and free VRAM everywhere |

`run` also takes `--count N`, `--mode shard|mirror`, `--seed N|random|keep`, `--dest PATH`,
`--only A,B`, `--run-id NAME`, `--no-collect`, `--skip-check`, `--strict`, `--dry-run`,
`--json FILE`.

A job file is what *Save as job file* writes — see [jobs/example.json](jobs/example.json):

```json
{
  "name": "campaign-a",
  "workflow": "../workflows/campaign_api.json",
  "assets": ["D:\\footage\\clip.mp4"],
  "mode": "shard",
  "count": 200,
  "seed": "random",
  "overrides": [
    { "title": "Positive Prompt", "field": "text", "value": "a cinematic portrait, volumetric fog, 85mm" },
    { "node": "3", "field": "steps", "value": 30 }
  ]
}
```

Selectors: `"node": "3"` (id from the API JSON), `"title": "Positive Prompt"` (the node's title in
the graph), or `"class": "KSampler"` (every node of that class).

---

## Testing without GPUs

`tools/mock-comfy.js` is a fake ComfyUI that speaks the same API, validates file names the way
the real one does, and emits a small PNG per job:

```bash
node tools/mock-comfy.js --port 8801 --name MOCK-01 --delay 3
```

The test suite starts its own mocks plus the real web server and drives both the engine and the
HTTP API the way the browser does:

```bash
npm test
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `cannot connect (ComfyUI not running, or still bound to 127.0.0.1)` | Step 1a not done, or ComfyUI is not started |
| `no answer (host up but nothing listening, or blocked by the firewall)` | Firewall rule missing, or the wrong port |
| `This is a UI workflow, not an API workflow` | Re-export with **Workflow → Export (API)** |
| `custom node not installed: X` | Install X on that machine with ComfyUI Manager, restart it |
| `'foo.safetensors' is not on this machine` | Copy the model to the same relative path under `models/` |
| `'clip.mp4' is not on this machine` | An input file, not a model: add it under Input files, or drop it in that machine's `ComfyUI\input` |
| `rejected the workflow: node 1 (LoadVideo): file - Invalid video file: clip.mp4` | ComfyUI says that name does not resolve in its `input` folder — same fix as above. The machine is fine, so the run stops instead of blaming it |
| `this machine's ComfyUI does not offer 'x' for node N …` | That build genuinely lacks the option — usually an older/newer ComfyUI or a different custom node version. To run regardless, switch off *Check machines before running* on the Output tab |
| The file dialog does not appear | It opens on the machine running ComfyFleet. Driving the interface from another computer? Start the server with `COMFYFLEET_PICKER=off` and type paths instead |
| Outputs are not appearing | The machine running ComfyFleet needs write access to the destination; check `collectErrors` in `run.json` |
| `still running after N minutes - giving up on it` | The stall timeout counts only time spent *executing*, so queued work is never written off. Raise `fleet.stallTimeout` in `config/nodes.json` for very long videos |
| A change to the interface did not appear | Reload the page. Changes under `src/` need the server restarted (`npm start`); files under `public/` only need a reload |
| One machine is much slower | Normal with mixed GPUs — split mode already compensates. Raise its `slots` if it sits idle |
| `still running after N minutes - giving up on it` | The job really did run that long. Raise `fleet.stallTimeout` in `config/nodes.json` (milliseconds, 60 min by default) for slow video work. Time spent waiting in the queue does **not** count towards it |
| `the machine no longer knows about this job` | ComfyUI restarted, or its queue was cleared, while the job was in flight. The task is requeued to another machine when one is free |

---

## Layout

```
bin/cf.js              command line entry point
src/server.js          web server: JSON API + live event stream
src/runner.js          dispatch, monitor, collect
src/client.js          the ComfyUI HTTP API
src/preflight.js       node / model / input verification
src/workflow.js        API-workflow loading, inspection, patching
src/discover.js        LAN scan
src/config.js          fleet and job configuration
public/                the interface: index.html, app.js, styles.css, vendored Tailwind
config/nodes.json      the fleet: machines, ports, output location
config/ui-state.json   what the browser had open last (written automatically)
jobs/*.json            saved jobs
workflows/*.json       API-format exports from ComfyUI
tests/run-tests.js     end-to-end tests
tools/mock-comfy.js    fake ComfyUI for testing
tools/Enable-ComfyRemote.ps1   per-machine firewall + listen setup
tools/Sync-Models.ps1          mirror models/custom_nodes from a master share
```

Tailwind is vendored in `public/vendor/` so the interface works with no internet access.
