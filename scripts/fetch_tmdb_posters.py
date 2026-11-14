#!/usr/bin/env python3
"""Build data/posters.json: TMDB poster/backdrop paths for every catalog title.

Requires TMDB_API_KEY (v3 key) in the environment. Never commit the key.
Only image *paths* are stored; the site loads them from TMDB's official
image CDN (image.tmdb.org) with attribution in the footer.

Usage:  TMDB_API_KEY=... python3 scripts/fetch_tmdb_posters.py
Re-running keeps existing matches and only looks up new titles
(pass --refresh to redo everything).
"""
import json, os, sys, re, time, unicodedata
import urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "posters.json")
KEY = os.environ.get("TMDB_API_KEY")
if not KEY:
    sys.exit("TMDB_API_KEY not set")


def load(name):
    with open(os.path.join(ROOT, "data", name)) as f:
        return json.load(f)


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def api(path, **params):
    params["api_key"] = KEY
    url = f"https://api.themoviedb.org/3{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 + attempt * 2)
                continue
            if e.code == 404:
                return None
            raise
        except Exception:
            time.sleep(1 + attempt)
    return None


def pick(results, title, year):
    if not results:
        return None
    t = norm(title)
    def score(r):
        s = 0
        if norm(r.get("title")) == t or norm(r.get("original_title")) == t:
            s += 10
        ry = (r.get("release_date") or "")[:4]
        if year and ry.isdigit():
            d = abs(int(ry) - int(year))
            s += 6 if d == 0 else 3 if d == 1 else -4
        if r.get("poster_path"):
            s += 2
        s += min(r.get("popularity") or 0, 50) / 50
        return s
    best = max(results, key=score)
    return best if score(best) >= 8 else None


def lookup(m):
    title, year = m["title"], m.get("year")
    res = None
    if year:
        d = api("/search/movie", query=title, year=year, include_adult="false")
        res = pick((d or {}).get("results"), title, year)
        if not res:
            d = api("/search/movie", query=title, primary_release_year=year, include_adult="false")
            res = pick((d or {}).get("results"), title, year)
    if not res:
        d = api("/search/movie", query=title, include_adult="false")
        res = pick((d or {}).get("results"), title, year)
    if not res:
        return None
    return {
        "tmdb_id": res["id"],
        "poster": res.get("poster_path"),
        "backdrop": res.get("backdrop_path"),
    }


def main():
    movies = load("movies.json")["movies"]
    manual = load("manual-movies.json").get("movies", [])
    items = [(str(m["plex_rating_key"]), m) for m in movies] + [(m["id"], m) for m in manual]
    existing = {}
    if os.path.exists(OUT) and "--refresh" not in sys.argv:
        existing = load("posters.json").get("posters", {})
    todo = [(k, m) for k, m in items if k not in existing]
    print(f"{len(items)} titles, {len(todo)} to look up")
    with ThreadPoolExecutor(max_workers=8) as ex:
        for (k, _), hit in zip(todo, ex.map(lambda km: lookup(km[1]), todo)):
            existing[k] = hit
    found = sum(1 for v in existing.values() if v and v.get("poster"))
    out = {
        "source": "TMDB (themoviedb.org) — image paths only; load from https://image.tmdb.org/t/p/<size><path>",
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "posters": {k: v for k, v in sorted(existing.items()) if v},
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"posters: {found}/{len(items)}; wrote {OUT} ({os.path.getsize(OUT)//1024} KB)")


if __name__ == "__main__":
    main()
