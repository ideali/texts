# Quran Tracker — Project Context

## Overview
Quran recitation tracker web app. User reads Quran aloud, app recognizes speech and tracks progress.

## Architecture
- **Frontend**: `quran-tracker/web/` — standalone HTML/JS/CSS (mobile-first)
- **WASM core**: `quran-tracker/src/` — Rust compiled to WASM for text matching (optional, JS fallback exists)
- **Data**: `quran-tracker/web/data/quran_full.json` — 6236 ayahs, Arabic + Russian tafsir (As-Saadi)
- **Deploy target**: VPS 31.40.29.176, domain aniner.xyz/quran, nginx

## Key Files
- `web/index-mobile.html` — main mobile UI (primary)
- `web/app-standalone.js` — all app logic, speech recognition, matching
- `web/style.css` — styles
- `web/data/quran_full.json` — full Quran dataset
- `deploy/deploy.sh` — manual deploy script
- `deploy/nginx.conf` — nginx config

## CI/CD (GitHub Actions)
- `.github/workflows/deploy.yml` — auto-deploys `web/` to VPS on push
- `.github/workflows/fetch-data.yml` — downloads tafsir/quran data (manual trigger)
- **Required secrets**: `VPS_USER`, `VPS_SSH_KEY` (see setup below)

## Data Sources
- Arabic text: quran.com API (resource 127 = Uthmani script)
- Russian tafsir: As-Saadi from spa5k/tafsir_api CDN
- Scripts: `fetch_quran_full.py`, `download_saadi.py`, `build_quran_full.py`

## Common Tasks

### Deploy changes
Just push to main — GitHub Actions handles rsync to VPS.

### Update tafsir data
Run "Fetch Quran Data" workflow from GitHub Actions (workflow_dispatch).

### Add new feature to the app
Edit `web/app-standalone.js` and `web/index-mobile.html`. The app is a single-page app, no build step needed.

### Test locally
Open `web/index-mobile.html` in browser (needs a local server for fetch to work):
```bash
cd quran-tracker/web && python3 -m http.server 8080
```

## Network Limitations
Claude Code sandbox blocks external network. For tasks requiring external APIs:
1. Use GitHub Actions workflows (they have full network access)
2. Commit download scripts, trigger workflow, data gets committed back
3. Never try to curl/fetch external APIs directly — it will fail
4. To trigger a workflow: `gh workflow run <name>.yml` (if gh CLI is available)

## Deploying Changes
Two methods:
1. **Auto-deploy**: push to `main` → GitHub Actions rsync to VPS
2. **Manual trigger**: `gh workflow run deploy.yml --ref main`

Always commit and push — the CI/CD pipeline handles the rest.

## Downloading / Updating Data
Never try to fetch external APIs from sandbox. Instead:
1. Run "Fetch Quran Data" workflow: `gh workflow run fetch-data.yml -f source=saadi`
2. Or commit a download script and trigger the workflow
3. Data gets committed back to the repo automatically

## VPS Setup (one-time)
Server: 31.40.29.176 (aniner.xyz)
Web root: /var/www/quran-tracker/
Web server: nginx
URL: https://aniner.xyz/quran/
Required GitHub Secrets: `VPS_USER`, `VPS_SSH_KEY`

## SessionStart Hook
`.claude/hooks/setup-env.sh` runs at every session start.
It sets environment variables and verifies data files exist.
Config: `.claude/settings.json`
