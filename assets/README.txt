Put input files here (reference images, video, audio, masks) that your workflows
load with LoadImage / LoadVideo / LoadAudio nodes.

Anything listed under a job's `assets:` key is uploaded to every machine's
ComfyUI/input folder before the run, so the nodes resolve on all of them.

Models (checkpoints, LoRAs, VAEs, ControlNets) do NOT go here - see the README
section "Get the models and nodes in sync".
