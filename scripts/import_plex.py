#!/usr/bin/env python3
"""Re-import Koch_Plex movie library into data/movies.json for GitHub Pages.

Requires env:
  PLEX_TOKEN   Plex account token (never commit this)

Optional env:
  PLEX_SERVER_NAME   Prefer this friendly name (default: Koch_Plex)
  PLEX_BASE          Skip discovery and hit this base URL directly
  OUT_PATH           Output JSON path (default: data/movies.json next to repo root)
  SECTION_TYPE       Library type to export (default: movie)

Discovery uses https://plex.tv/api/resources?includeHttps=1&includeRelay=1
and prefers local → remote → relay connections that answer /identity.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "data" / "movies.json"
PLEX_TV = "https://plex.tv"
TZ = ZoneInfo("America/Chicago")
CLIENT_ID = "stevenkoch-github-io-movie-db"


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def http_get(url: str, headers: dict | None = None, timeout: float = 60) -> bytes:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        body = e.read()[:300] if e.fp else b""
        raise RuntimeError(f"HTTP {e.code} for {url.split('?')[0]}: {body!r}") from e


def plex_headers(token: str) -> dict:
    return {
        "Accept": "application/xml",
        "X-Plex-Token": token,
        "X-Plex-Client-Identifier": CLIENT_ID,
        "X-Plex-Product": "Koch Movie DB Import",
        "X-Plex-Version": "1.0",
    }


def with_token(url: str, token: str) -> str:
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}X-Plex-Token={urllib.parse.quote(token)}"


def discover_base(token: str, prefer_name: str | None) -> tuple[str, str]:
    """Return (base_url, server_name) using plex.tv resources + relay-friendly URIs."""
    url = f"{PLEX_TV}/api/resources?includeHttps=1&includeRelay=1"
    raw = http_get(url, headers=plex_headers(token), timeout=45)
    root = ET.fromstring(raw)
    servers = []
    for device in root.findall("Device"):
        provides = (device.get("provides") or "").split(",")
        if "server" not in provides:
            continue
        name = device.get("name") or device.get("clientIdentifier") or "Plex"
        conns = []
        for conn in device.findall("Connection"):
            uri = conn.get("uri")
            if not uri:
                continue
            conns.append(
                {
                    "uri": uri.rstrip("/"),
                    "local": (conn.get("local") or "0") == "1",
                    "relay": (conn.get("relay") or "0") == "1",
                    "protocol": conn.get("protocol") or "",
                }
            )
        # Prefer local, then non-relay remote, then relay; https before http within tier
        def rank(c: dict) -> tuple:
            tier = 0 if c["local"] else (2 if c["relay"] else 1)
            proto = 0 if c["protocol"] == "https" else 1
            return (tier, proto, c["uri"])

        conns.sort(key=rank)
        servers.append({"name": name, "connections": conns})

    if not servers:
        die("No Plex servers found for this token via plex.tv/api/resources")

    chosen = None
    if prefer_name:
        for s in servers:
            if s["name"].lower() == prefer_name.lower():
                chosen = s
                break
        if chosen is None:
            names = ", ".join(s["name"] for s in servers)
            print(f"warn: preferred server {prefer_name!r} not found; available: {names}", file=sys.stderr)
    if chosen is None:
        chosen = servers[0]

    last_err = None
    for c in chosen["connections"]:
        base = c["uri"]
        try:
            http_get(with_token(f"{base}/identity", token), headers=plex_headers(token), timeout=20)
            kind = "local" if c["local"] else ("relay" if c["relay"] else "remote")
            print(f"connected via {kind}: {base} ({chosen['name']})")
            return base, chosen["name"]
        except Exception as e:  # noqa: BLE001 — try next connection
            last_err = e
            continue
    die(f"Could not reach server {chosen['name']}: {last_err}")


def list_movie_sections(base: str, token: str) -> list[dict]:
    raw = http_get(with_token(f"{base}/library/sections", token), headers=plex_headers(token))
    root = ET.fromstring(raw)
    out = []
    for d in root.findall(".//Directory"):
        if (d.get("type") or "") == "movie":
            out.append({"key": d.get("key"), "title": d.get("title")})
    return out


def fetch_all_movies(base: str, token: str, section_key: str) -> list[ET.Element]:
    """Page through /library/sections/{key}/all for movies."""
    items: list[ET.Element] = []
    start = 0
    page = 200
    while True:
        q = urllib.parse.urlencode({"X-Plex-Container-Start": start, "X-Plex-Container-Size": page})
        url = with_token(f"{base}/library/sections/{section_key}/all?{q}", token)
        raw = http_get(url, headers=plex_headers(token), timeout=120)
        root = ET.fromstring(raw)
        batch = root.findall("Video")
        if not batch:
            break
        items.extend(batch)
        total = int(root.get("totalSize") or root.get("size") or len(batch))
        start += len(batch)
        print(f"  fetched {len(items)}/{total} from section {section_key}")
        if start >= total:
            break
    return items


def video_to_movie(v: ET.Element) -> dict:
    genres = [g.get("tag") for g in v.findall("Genre") if g.get("tag")]
    resolutions = []
    containers = []
    for part in v.findall(".//Part"):
        # Media/@videoResolution is on parent Media
        pass
    for media in v.findall("Media"):
        res = (media.get("videoResolution") or "").strip().lower()
        if res and res not in resolutions:
            resolutions.append(res)
        for part in media.findall("Part"):
            c = (part.get("container") or media.get("container") or "").strip().lower()
            if c and c not in containers:
                containers.append(c)
    has_4k = any(r in ("4k", "uhd") for r in resolutions)
    year_raw = v.get("year")
    year = int(year_raw) if year_raw and str(year_raw).isdigit() else None
    duration = v.get("duration")
    return {
        "plex_rating_key": v.get("ratingKey"),
        "title": v.get("title") or "Untitled",
        "year": year,
        "studio": v.get("studio") or None,
        "genres": genres,
        "summary": v.get("summary") or "",
        "content_rating": v.get("contentRating") or None,
        "duration_ms": int(duration) if duration and str(duration).isdigit() else None,
        "added_at": v.get("addedAt"),
        "guid": v.get("guid"),
        "resolutions": resolutions,
        "containers": containers,
        "section": None,  # filled by caller
        "formats": {
            "uhd4k": has_4k,  # Plex *file* resolution has 4K — not physical UHD disc
            "bluray": False,
            "dvd": False,
            "vhs": False,
            "digital": True,
            "plex": True,
        },
    }


def main() -> None:
    token = os.environ.get("PLEX_TOKEN", "").strip()
    if not token:
        die("Set PLEX_TOKEN in the environment (do not commit it).")

    prefer = os.environ.get("PLEX_SERVER_NAME", "Koch_Plex").strip() or None
    out_path = Path(os.environ.get("OUT_PATH", str(DEFAULT_OUT)))
    forced_base = os.environ.get("PLEX_BASE", "").strip() or None

    if forced_base:
        base = forced_base.rstrip("/")
        server_name = prefer or "Plex"
        http_get(with_token(f"{base}/identity", token), headers=plex_headers(token), timeout=20)
        print(f"connected via PLEX_BASE: {base}")
    else:
        base, server_name = discover_base(token, prefer)

    sections = list_movie_sections(base, token)
    if not sections:
        die("No movie library sections found")
    print("sections:", ", ".join(f"{s['title']}({s['key']})" for s in sections))

    movies: list[dict] = []
    seen: set[str] = set()
    for sec in sections:
        for v in fetch_all_movies(base, token, sec["key"]):
            m = video_to_movie(v)
            m["section"] = sec["title"]
            key = m["plex_rating_key"] or f"{m['title']}|{m['year']}"
            if key in seen:
                continue
            seen.add(key)
            movies.append(m)

    movies.sort(key=lambda m: ((m.get("title") or "").lower(), m.get("year") or 0))
    payload = {
        "source": server_name,
        "imported_at": datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "movie_count": len(movies),
        "movies": movies,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(movies)} movies → {out_path}")
    print("note: formats.uhd4k means Plex has a 4K *file*; mark physical discs in the site UI / formats-overlay.json")


if __name__ == "__main__":
    main()
