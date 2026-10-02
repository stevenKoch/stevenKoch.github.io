# Koch Movie Database

Static family movie catalog for **GitHub Pages** (HTML / CSS / JS only).

**Live:** https://stevenkoch.github.io/

Browse ~995 titles imported from **Koch_Plex**, filter by year / genre / format, mark physical discs you own, and keep a wishlist.

## Features

- **Browse** — search title/studio/genre; filter by year range, genre, and format chips
- **On Plex vs physical** — “On Plex” and resolution badges come from the Plex import; **4K Disc / Blu-ray / DVD / VHS / Digital** are ownership flags you edit
- **Cards or table** view
- **Wishlist** — titles you want; stored in `localStorage` with downloadable JSON to commit
- **Formats overlay** — click a movie → toggle physical formats; download JSON to commit

## Repo layout

```
index.html                 # Pages site root
css/app.css
js/app.js
data/movies.json           # Plex import (do not put tokens here)
data/formats-overlay.json  # Physical ownership overlays (keyed by plex_rating_key)
data/wishlist.json         # Committed wishlist baseline
scripts/import_plex.py     # Re-import from Plex
assets/                    # Theater background + logos
legacy/                    # Old PHP Bootstrap sketch (archived)
```

## How to mark Blu-ray / DVD / etc.

1. Open the live site (or local `index.html` via any static server).
2. Click a movie card (or table row).
3. Toggle **4K Disc**, **Blu-ray**, **DVD**, **VHS**, and/or **Digital**.
4. Changes save in **this browser** (`localStorage`) right away.
5. Click **Download formats overlay JSON** → save as `data/formats-overlay.json` → commit & push so everyone sees them.

> **Note:** A “Plex 4K file” badge means the Plex *file* is 4K resolution. That is **not** the same as owning a **4K UHD disc** — use the **4K Disc** toggle for shelf ownership.

## Wishlist

- Add items in the Wishlist panel, or from a movie modal.
- **Download wishlist JSON** → replace `data/wishlist.json` → commit.

## Re-import from Plex

Requires a Plex account token in the environment (**never commit it**).

```bash
export PLEX_TOKEN='your-token-here'   # do not commit
# optional:
# export PLEX_SERVER_NAME='Koch_Plex'
# export PLEX_BASE='http://192.168.x.x:32400'  # skip discovery

python3 scripts/import_plex.py
```

The script:

1. Calls `https://plex.tv/api/resources?includeHttps=1&includeRelay=1`
2. Finds the preferred server (default name `Koch_Plex`)
3. Tries local → remote → relay connections until `/identity` answers
4. Exports all movie library sections to `data/movies.json`

Physical overlays in `data/formats-overlay.json` are **not** wiped by re-import (they merge by `plex_rating_key` in the UI).

### Getting a Plex token

Sign in at [plex.tv](https://www.plex.tv), open a plex.tv XML/API page while logged in, or use Plex’s documented token methods. Prefer a short-lived local env var or a gitignored secrets file — **never** add the token to this repo.

## Local preview

```bash
cd /path/to/stevenKoch.github.io
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

(Fetching `data/*.json` needs a local server; `file://` may block.)

## GitHub Pages

Site is served from the **repository root** (`index.html`). In the repo **Settings → Pages**:

- Source: **Deploy from a branch**
- Branch: `main` / `/ (root)`

No build step required.

## Privacy

- Do **not** commit `PLEX_TOKEN`, `.env`, or `.secrets*` files (see `.gitignore`).
- `data/movies.json` contains titles/metadata only — no auth tokens.
