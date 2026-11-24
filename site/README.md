# ComfyFleet documentation site

This folder builds the public [ComfyFleet documentation](https://rmanmetaverse.github.io/ComfyUI-Orchestrator-LAN/). It is separate from the ComfyFleet application, which runs locally with `npm start` from the repository root.

Use Node.js 20 or newer:

```bash
cd site
npm ci
npm start
```

`npm start` generates the API pages from `static/openapi.yaml` and serves the site locally. Run `npm run build` to generate the API pages and static website in `build/`. Edit `docs/quickstart.mdx` and `docs/troubleshooting.mdx` for prose, and `static/openapi.yaml` for the endpoint reference. The generated `docs/api/` folder is ignored by Git.

The GitHub Actions workflow in `.github/workflows/docs-pages.yml` builds this folder after a push to `main` that changes `site/`, then publishes `site/build` to GitHub Pages. The repository's **Settings → Pages → Source** must be **GitHub Actions**.
