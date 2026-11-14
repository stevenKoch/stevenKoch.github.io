# Koch Movie Database

Static family movie catalog for **GitHub Pages** (HTML / CSS / JS only).

**Live:** https://stevenkoch.github.io/

Browse ~995 titles imported from **Koch_Plex**, filter by year / genre / format, mark physical discs you own, and keep a wishlist.

## Features

- **Browse** — search title/studio/genre; filter by year range, genre, and format chips
- **On Plex vs physical** — “On Plex” and resolution badges come from the Plex import; **4K Disc / Blu-ray / DVD / VHS / Digital** are ownership flags you edit. A **Daughter's VHS** collection tag marks tapes on that shelf (filter chip on the toolbar).
- **Poster grid or list** view, sort by title / recently added / year, live facet counts on every chip
- **Posters** from TMDB (`data/posters.json`, image paths only); titles without a match get a generated Koch title card
- **Wishlist** — titles you want; stored in `localStorage` with downloadable JSON to commit
- **Formats overlay** — click a movie → toggle physical formats; download JSON to commit
- **Add movie** — manually add titles not in Plex yet (physical/digital only, or before rip); stored in `localStorage` + downloadable `data/manual-movies.json`

## Repo layout

```
index.html                 # Pages site root
css/app.css
js/app.js
data/movies.json           # Plex import (do not put tokens here)
data/manual-movies.json    # Manual adds (not yet in Plex); ids like manual-<slug>-<year>
data/formats-overlay.json  # Physical ownership overlays (keyed by plex_rating_key / manual id)
data/wishlist.json         # Committed wishlist baseline
data/posters.json          # TMDB poster/backdrop paths keyed like formats-overlay (optional)
scripts/import_plex.py     # Re-import from Plex
scripts/fetch_tmdb_posters.py  # Build data/posters.json (needs TMDB_API_KEY in env)
assets/fonts/              # Self-hosted Inter + Fraunces (SIL OFL)
assets/                    # Theater background + logos
legacy/                    # Old PHP Bootstrap sketch (archived)
```

## How to mark Blu-ray / DVD / etc.

1. Open the live site (or local `index.html` via any static server).
2. Click a movie poster (or list row).
3. Toggle **4K Disc**, **Blu-ray**, **DVD**, **VHS**, and/or **Digital**.
4. Changes save in **this browser** (`localStorage`) right away.
5. Click **Export → Formats overlay** → save as `data/formats-overlay.json` → commit & push so everyone sees them.

> **Note:** A “Plex 4K file” badge means the Plex *file* is 4K resolution. That is **not** the same as owning a **4K UHD disc** — use the **4K Disc** toggle for shelf ownership.

## Add a movie (not in Plex yet)

1. Click **Add movie** on the main toolbar.
2. Enter **title** (required), optional year / genres / studio / live-or-animated.
3. Check formats you own (**4K Disc**, **Blu-ray**, **DVD**, **VHS**, **Digital**). **On Plex** defaults off.
4. Optional: **Add to wishlist instead of owned catalog**.
5. Save — stored in this browser immediately.
6. If title+year already exists from Plex, you’ll be offered to **update formats** on that entry (no duplicate).
7. **Export → Manual movies** → save as `data/manual-movies.json` → commit & push.

On load the app merges `data/movies.json` + `data/manual-movies.json` + `localStorage` (local wins for the same `manual-…` id). Plex re-import is unchanged.

## Wishlist

- Open **Wishlist** in the top bar, or add from a movie's detail view.
- **Export → Wishlist** → replace `data/wishlist.json` → commit.

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

Physical overlays in `data/formats-overlay.json` are **not** wiped by re-import (they merge by `plex_rating_key` in the UI). Overlay objects may also include a `collection` string (currently `Daughter's VHS`) so a household shelf can be filtered without changing the Plex import.

### Getting a Plex token

Sign in at [plex.tv](https://www.plex.tv), open a plex.tv XML/API page while logged in, or use Plex’s documented token methods. Prefer a short-lived local env var or a gitignored secrets file — **never** add the token to this repo.

## Posters (TMDB)

```bash
export TMDB_API_KEY='...'   # v3 key, never commit it
python3 scripts/fetch_tmdb_posters.py         # only looks up titles not already matched
python3 scripts/fetch_tmdb_posters.py --refresh
```

Only TMDB image *paths* are stored; the browser loads them from `image.tmdb.org`. Run it after each Plex re-import or manual add. The footer carries TMDB's required attribution.

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
