(() => {
  "use strict";

  const LS_FORMATS = "kochMovieDb.formatsOverlay.v1";
  const LS_WISHLIST = "kochMovieDb.wishlist.v1";
  const LS_MANUAL = "kochMovieDb.manualMovies.v1";

  const PHYSICAL_KEYS = ["uhd_disc", "bluray", "dvd", "vhs", "digital"];
  const PHYSICAL_LABELS = {
    uhd_disc: "4K Disc",
    bluray: "Blu-ray",
    dvd: "DVD",
    vhs: "VHS",
    digital: "Digital",
  };

  const state = {
    movies: [],
    meta: {},
    formatsOverlay: { formats: {} },
    wishlist: { items: [] },
    manualMovies: { movies: [] },
    filters: {
      q: "",
      genre: "",
      yearMin: "",
      yearMax: "",
      formats: new Set(),
      wishlistOnly: false,
      collection: "",
    },
    sort: "title",
    view: "cards",
    selectedKey: null,
    posters: {},
    firstRender: true,
  };

  const TMDB_IMG = "https://image.tmdb.org/t/p/";
  const COLLECTION_VHS = "Daughter's VHS";
  // Radarr WebUI on the NAS, reachable over Tailscale. No API key: this only opens Radarr's own add-movie search.
  const RADARR_URL = "http://100.65.30.111:30025";
  const SEARCH_PAGE = 40;

  function radarrUrl(term) {
    return `${RADARR_URL}/add/new?term=${encodeURIComponent(String(term || "").trim())}`;
  }

  /* ---------- Forgiving search ---------- */

  const STOP = new Set(["the", "a", "an", "and", "of"]);

  /** lowercase, strip accents, & → and, drop apostrophes, other punctuation → space. */
  function normText(str) {
    return String(str || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(ii|iii|iv|vi|vii|viii)\b/g, (r) => ROMAN[r])
      .trim();
  }

  const ROMAN = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8" };

  function coreOf(n) {
    return n.split(" ").filter((w) => w && !STOP.has(w)).join(" ");
  }

  function stripArticle(n) {
    return n.replace(/^(the|a|an) /, "");
  }

  /** Optimal string alignment distance, bailing out once it exceeds max. */
  function editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  function allowedTypos(len) {
    return len >= 9 ? 2 : len >= 5 ? 1 : 0;
  }

  function searchIndex(movie) {
    if (movie._idx) return movie._idx;
    const title = stripArticle(normText(movie.title));
    const extra = normText(`${movie.studio || ""} ${(movie.genres || []).join(" ")} ${movieCollection(movie) || ""}`);
    movie._idx = {
      title,
      compact: title.replace(/ /g, ""),
      core: coreOf(title),
      words: title.split(" ").filter(Boolean),
      extraWords: extra.split(" ").filter(Boolean),
      year: movie.year ? Number(movie.year) : null,
    };
    return movie._idx;
  }

  function parseQuery(raw) {
    let n = normText(raw);
    let year = null;
    const m = n.match(/(?:^| )((?:19|20)\d\d)$/) || n.match(/^((?:19|20)\d\d) /);
    if (m && n !== m[1]) {
      year = Number(m[1]);
      n = n.replace(m[0], " ").trim();
    } else if (m) {
      year = Number(m[1]); // query is only a year: match titles from that year (or containing it)
      n = "";
    }
    n = stripArticle(n);
    const tokens = n.split(" ").filter(Boolean);
    const core = tokens.filter((t) => !STOP.has(t));
    return { raw: String(raw || "").trim(), text: n, core: coreOf(n), compact: n.replace(/ /g, ""), tokens: core.length ? core : tokens, year };
  }

  /** How well one query word matches a list of words: 3 exact, 2 prefix, 1 typo, 0 none. */
  function wordMatch(q, words, last) {
    let best = 0;
    const maxTypos = allowedTypos(q.length);
    for (const w of words) {
      if (w === q) return 3;
      if (w.startsWith(q) && (last || q.length >= 3)) best = Math.max(best, 2);
      else if (maxTypos && best < 1) {
        if (editDistance(q, w, maxTypos) <= maxTypos) best = 1;
        else if (last && q.length >= 5 && w.length > q.length && editDistance(q, w.slice(0, q.length), maxTypos) <= maxTypos) best = 1;
      }
    }
    return best;
  }

  /** 0 = no match; higher = better. */
  function searchScore(movie, q) {
    const idx = searchIndex(movie);
    let yearBonus = 0;
    if (q.year) {
      if (idx.year === q.year) yearBonus = 25;
      else if (!idx.title.includes(String(q.year))) return 0;
    }
    if (!q.tokens.length) return q.year ? 50 + yearBonus : 0;

    if (idx.title === q.text) return 100 + yearBonus;
    if (q.core && idx.core === q.core) return 95 + yearBonus;
    if (idx.title.startsWith(q.text)) return 85 + yearBonus - Math.min(10, idx.title.length - q.text.length) / 2;
    if (q.compact.length >= 4 && idx.compact.includes(q.compact)) return 70 + yearBonus;

    let total = 0;
    let typos = 0;
    let extraHits = 0;
    for (let i = 0; i < q.tokens.length; i++) {
      const t = q.tokens[i];
      const last = i === q.tokens.length - 1;
      const m = wordMatch(t, idx.words, last);
      if (m) {
        total += m;
        if (m === 1) typos++;
        continue;
      }
      // studio / genre / collection words: exact or prefix only
      if (t.length >= 3 && idx.extraWords.some((w) => w === t || w.startsWith(t))) {
        extraHits++;
        continue;
      }
      return 0;
    }
    if (extraHits === q.tokens.length) return 10 + (yearBonus ? 5 : 0); // studio/genre/collection only
    if (extraHits) return Math.max(20, 40 + (total / (q.tokens.length * 3)) * 20 - typos * 4 - extraHits * 6 + yearBonus);
    // Whole-title typo match ("pinochio" → "pinocchio")
    return 40 + (total / (q.tokens.length * 3)) * 20 - typos * 4 - extraHits * 6 + yearBonus;
  }

  const scoreCache = { q: null, parsed: null, scores: new Map() };

  function queryScore(movie) {
    const raw = state.filters.q.trim();
    if (scoreCache.q !== raw) {
      scoreCache.q = raw;
      scoreCache.parsed = parseQuery(raw);
      scoreCache.scores = new Map();
    }
    const key = movieKey(movie);
    let sc = scoreCache.scores.get(key);
    if (sc === undefined) {
      sc = searchScore(movie, scoreCache.parsed);
      scoreCache.scores.set(key, sc);
    }
    return sc;
  }

  function invalidateSearch() {
    scoreCache.q = null;
    state.movies.forEach((m) => delete m._idx);
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function movieKey(m) {
    return String(m.id || m.plex_rating_key || `${m.title}|${m.year || ""}`);
  }

  function loadLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return structuredClone(fallback);
      return JSON.parse(raw);
    } catch {
      return structuredClone(fallback);
    }
  }

  function saveLS(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function slugify(title) {
    return String(title || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled";
  }

  function manualId(title, year) {
    const y = year != null && year !== "" ? String(year) : "unknown";
    return `manual-${slugify(title)}-${y}`;
  }

  function titlesMatch(a, b) {
    return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  }

  function findByTitleYear(title, year) {
    const y = year === "" || year == null ? null : Number(year);
    return state.movies.find((m) => {
      if (!titlesMatch(m.title, title)) return false;
      if (y == null || Number.isNaN(y)) return m.year == null;
      return Number(m.year) === y;
    });
  }

  /** Merge base Plex formats with physical overlay. */
  function effectiveFormats(movie) {
    const base = movie.formats || {};
    const over = state.formatsOverlay.formats[movieKey(movie)] || {};
    return {
      plex: over.plex != null ? !!over.plex : !!base.plex,
      // Plex file 4K (resolution) — not physical disc
      plex_4k_file: !!base.uhd4k || (movie.resolutions || []).some((r) => String(r).toLowerCase() === "4k"),
      digital: over.digital != null ? !!over.digital : !!base.digital,
      bluray: over.bluray != null ? !!over.bluray : !!base.bluray,
      dvd: over.dvd != null ? !!over.dvd : !!base.dvd,
      vhs: over.vhs != null ? !!over.vhs : !!base.vhs,
      uhd_disc: over.uhd_disc != null ? !!over.uhd_disc : !!over.uhd4k, // allow old key
    };
  }

  function movieCollection(movie) {
    const over = state.formatsOverlay.formats[movieKey(movie)] || {};
    return over.collection || movie.collection || null;
  }

  function isWishlisted(movie) {
    const title = (movie.title || "").toLowerCase();
    const year = movie.year;
    return state.wishlist.items.some((w) => {
      if ((w.title || "").toLowerCase() !== title) return false;
      if (w.year && year && Number(w.year) !== Number(year)) return false;
      return true;
    });
  }

  function matchesFilters(movie) {
    const f = state.filters;
    if (f.q.trim() && !queryScore(movie)) return false;
    if (f.genre && !(movie.genres || []).includes(f.genre)) return false;
    if (f.yearMin && (movie.year == null || movie.year < Number(f.yearMin))) return false;
    if (f.yearMax && (movie.year == null || movie.year > Number(f.yearMax))) return false;
    if (f.wishlistOnly && !isWishlisted(movie)) return false;
    if (f.collection && movieCollection(movie) !== f.collection) return false;

    if (f.formats.size) {
      const fmt = effectiveFormats(movie);
      for (const chip of f.formats) {
        if (chip === "plex" && !fmt.plex) return false;
        if (chip === "uhd_disc" && !fmt.uhd_disc) return false;
        if (chip === "bluray" && !fmt.bluray) return false;
        if (chip === "dvd" && !fmt.dvd) return false;
        if (chip === "vhs" && !fmt.vhs) return false;
        if (chip === "digital" && !fmt.digital) return false;
        if (chip === "plex_4k" && !fmt.plex_4k_file) return false;
      }
    }
    return true;
  }

  function filteredMovies() {
    return state.movies.filter(matchesFilters);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isManual(movie) {
    return movie.source === "manual" || (movie.id && String(movie.id).startsWith("manual-"));
  }

  function posterInfo(movie) {
    return state.posters[movieKey(movie)] || null;
  }

  function posterUrl(movie, size = "w342") {
    const p = posterInfo(movie);
    return p && p.poster ? `${TMDB_IMG}${size}${p.poster}` : null;
  }

  function backdropUrl(movie, size = "w1280") {
    const p = posterInfo(movie);
    return p && p.backdrop ? `${TMDB_IMG}${size}${p.backdrop}` : null;
  }

  /** Stable hue per title for generated placeholder art. */
  function titleHue(title) {
    let h = 0;
    for (const ch of String(title || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  function placeholderHtml(movie) {
    return `<div class="ph" style="--h:${titleHue(movie.title)}">
      <span class="ph-mark">Koch</span>
      <span class="ph-title">${escapeHtml(movie.title)}</span>
      <span class="ph-year">${movie.year || "—"}</span>
    </div>`;
  }

  function artHtml(movie, size, alt = "") {
    const url = posterUrl(movie, size);
    if (!url) return placeholderHtml(movie);
    return `<img src="${url}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`;
  }

  function formatPills(movie) {
    const fmt = effectiveFormats(movie);
    const bits = [];
    if (isManual(movie)) bits.push(`<span class="pill manual">Manual</span>`);
    if (fmt.plex) bits.push(`<span class="pill plex">Plex</span>`);
    if (fmt.uhd_disc) bits.push(`<span class="pill">4K Disc</span>`);
    if (fmt.bluray) bits.push(`<span class="pill">Blu-ray</span>`);
    if (fmt.dvd) bits.push(`<span class="pill">DVD</span>`);
    if (fmt.vhs) bits.push(`<span class="pill vhs">VHS</span>`);
    if (fmt.digital) bits.push(`<span class="pill">Digital</span>`);
    return bits.join("");
  }
  // Back-compat name used by the table view.
  const formatBadges = formatPills;

  function posterFlags(movie) {
    const fmt = effectiveFormats(movie);
    const flags = [];
    if (fmt.uhd_disc || fmt.plex_4k_file) flags.push(`<span class="flag k4">4K</span>`);
    if (fmt.bluray) flags.push(`<span class="flag">Blu-ray</span>`);
    if (fmt.dvd) flags.push(`<span class="flag">DVD</span>`);
    if (fmt.vhs) flags.push(`<span class="flag vhs">VHS</span>`);
    if (isWishlisted(movie)) flags.push(`<span class="flag wish" title="On wishlist">♥</span>`);
    return flags.length ? `<div class="poster-flags">${flags.join("")}</div>` : "";
  }

  function runtime(movie) {
    const ms = Number(movie.duration_ms || 0);
    if (!ms) return null;
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    return h ? `${h}h ${mins % 60}m` : `${mins}m`;
  }

  function sortList(list) {
    const byTitle = (a, b) =>
      sortTitle(a.title).localeCompare(sortTitle(b.title), undefined, { numeric: true }) ||
      (a.year || 0) - (b.year || 0);
    const sorted = [...list];
    switch (state.sort) {
      case "recent":
        sorted.sort((a, b) => Number(b.added_at || 0) - Number(a.added_at || 0) || byTitle(a, b));
        break;
      case "year-desc":
        sorted.sort((a, b) => (b.year || 0) - (a.year || 0) || byTitle(a, b));
        break;
      case "year-asc":
        sorted.sort((a, b) => (a.year || 9999) - (b.year || 9999) || byTitle(a, b));
        break;
      default:
        sorted.sort(byTitle);
    }
    return sorted;
  }

  function sortTitle(t) {
    return String(t || "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/^(the|a|an)\s+/i, "")
      .toLowerCase();
  }

  function fmtNum(n) {
    return Number(n).toLocaleString("en-US");
  }

  function activeFilterCount() {
    const f = state.filters;
    return f.formats.size + (f.genre ? 1 : 0) + (f.yearMin || f.yearMax ? 1 : 0) + (f.wishlistOnly ? 1 : 0) + (f.collection ? 1 : 0);
  }

  function hasActiveFilters() {
    const f = state.filters;
    return !!(f.q.trim() || f.genre || f.yearMin || f.yearMax || f.formats.size || f.wishlistOnly || f.collection);
  }

  function renderStats(shown) {
    const total = state.movies.length;
    const physical = state.movies.filter((m) => {
      const f = effectiveFormats(m);
      return f.uhd_disc || f.bluray || f.dvd || f.vhs;
    }).length;
    const vhsShelf = state.movies.filter((m) => movieCollection(m) === COLLECTION_VHS).length;
    $("#stat-total").textContent = fmtNum(total);
    $("#stat-physical").textContent = fmtNum(physical);
    $("#stat-vhs").textContent = fmtNum(vhsShelf);
    $("#stat-wishlist").textContent = String(state.wishlist.items.length);
    const imported = state.meta.imported_at;
    let importedText = "—";
    if (imported) {
      const d = new Date(imported);
      importedText = Number.isNaN(d.getTime())
        ? imported
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
    $("#stat-imported").textContent = importedText;

    const f = state.filters;
    let heading = "Browse everything we own";
    if (f.q.trim()) heading = `Searching for “${f.q.trim()}”`;
    else if (f.collection) heading = f.collection;
    else if (f.wishlistOnly) heading = "Wishlist";
    else if (f.genre) heading = f.genre;
    else if (f.q.trim()) heading = `Searching for “${f.q.trim()}”`;
    else if (f.formats.size === 1) {
      const c = $(`.chip[data-format="${[...f.formats][0]}"]`);
      heading = c ? c.firstChild.textContent.trim() : "Filtered";
    } else if (hasActiveFilters()) heading = "Filtered";
    $("#result-count").innerHTML = `${escapeHtml(heading)}<span class="of">${fmtNum(shown)} of ${fmtNum(total)}</span>`;
    $("#active-filters").innerHTML = hasActiveFilters()
      ? `<button type="button" class="clear-link" data-clear>${activeFilterCount() ? "Clear search and filters" : "Clear search"}</button>`
      : "";
  }

  /** Facet counts: how many results each chip would give with the other filters as they are. */
  function renderChipCounts() {
    const f = state.filters;
    const withFilters = (mut) => {
      const saved = { formats: new Set(f.formats), collection: f.collection, wishlistOnly: f.wishlistOnly, genre: f.genre };
      mut();
      const n = state.movies.reduce((acc, m) => acc + (matchesFilters(m) ? 1 : 0), 0);
      Object.assign(f, saved);
      return n;
    };
    const setCount = (chip, n) => {
      chip.querySelector(".chip-count").textContent = fmtNum(n);
      chip.classList.toggle("is-empty", n === 0);
    };
    $$(".chip[data-format]").forEach((chip) => {
      setCount(chip, withFilters(() => f.formats.add(chip.dataset.format)));
    });
    const col = $("#chip-collection");
    setCount(col, withFilters(() => (f.collection = col.dataset.collection)));
    setCount($("#chip-wishlist"), withFilters(() => (f.wishlistOnly = true)));
    $$('#genre-chips .chip[data-genre]:not([data-genre=""])').forEach((chip) => {
      const g = chip.dataset.genre;
      setCount(chip, withFilters(() => (f.genre = g)));
    });
  }

  function renderGenreOptions() {
    const counts = new Map();
    state.movies.forEach((m) => (m.genres || []).forEach((g) => counts.set(g, (counts.get(g) || 0) + 1)));
    const genres = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const current = state.filters.genre;
    $("#genre-chips").innerHTML =
      `<button type="button" class="chip ${current ? "" : "active"}" data-genre="" aria-pressed="${!current}">All genres</button>` +
      genres
        .map(([g]) => {
          const on = g === current;
          return `<button type="button" class="chip ${on ? "active" : ""}" data-genre="${escapeHtml(g)}" aria-pressed="${on}">${escapeHtml(g)}<span class="chip-count"></span></button>`;
        })
        .join("");
  }

  function emptyHtml() {
    const f = state.filters;
    const msg = f.q.trim()
      ? `Nothing in the library matches “${escapeHtml(f.q.trim())}” with these filters.`
      : "No movies match this combination of filters.";
    return `<div class="empty">
      <div class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg></div>
      <h3>No titles here</h3>
      <p>${msg}</p>
      <button type="button" class="btn" data-clear>Clear filters</button>
    </div>`;
  }

  function renderCards(list) {
    const root = $("#movie-grid");
    if (!list.length) {
      root.innerHTML = emptyHtml();
      return;
    }
    const animate = state.firstRender;
    root.innerHTML = list
      .map((m, i) => {
        const key = movieKey(m);
        const genre = (m.genres || [])[0];
        const sub = [m.year || null, genre || null].filter(Boolean).join(" · ") || "—";
        const delay = animate && i < 40 ? ` style="animation-delay:${i * 18}ms"` : animate ? "" : ` style="animation:none"`;
        return `<article class="poster-card" data-key="${escapeHtml(key)}" tabindex="0" role="button" aria-label="${escapeHtml(`${m.title}${m.year ? ` (${m.year})` : ""}`)}"${delay}>
          <div class="poster-frame">
            ${artHtml(m, "w342")}
            ${posterFlags(m)}
            <div class="poster-hover">
              <div class="pill-row">${formatPills(m)}</div>
              ${m.summary ? `<p>${escapeHtml(m.summary)}</p>` : ""}
            </div>
          </div>
          <div class="poster-meta">
            <h3 class="poster-title">${escapeHtml(m.title)}</h3>
            <p class="poster-sub">${escapeHtml(String(sub))}</p>
          </div>
        </article>`;
      })
      .join("");
    state.firstRender = false;
  }

  function renderTable(list) {
    const body = $("#movie-table-body");
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="6">${emptyHtml()}</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((m) => {
        const key = movieKey(m);
        const genres = (m.genres || []).join(", ");
        return `<tr data-key="${escapeHtml(key)}" tabindex="0">
          <td class="title"><div class="row-title"><span class="thumb">${artHtml(m, "w92")}</span>${escapeHtml(m.title)}</div></td>
          <td>${m.year || "—"}</td>
          <td>${escapeHtml(genres || "—")}</td>
          <td>${escapeHtml(m.studio || "—")}</td>
          <td>${escapeHtml((m.resolutions || []).map((r) => String(r).toUpperCase()).join(", ") || "—")}</td>
          <td><div class="pill-row">${formatBadges(m)}</div></td>
        </tr>`;
      })
      .join("");
  }

  const CHECK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
  const X_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

  /** Ownership badges, in the order people think about them. */
  function ownershipBadges(movie) {
    const fmt = effectiveFormats(movie);
    const out = [];
    if (fmt.plex) {
      const res = (movie.resolutions || []).map((r) => {
        const v = String(r).toLowerCase();
        return v === "4k" ? "4K" : /^\d+$/.test(v) ? `${v}p` : v.toUpperCase();
      });
      out.push(`<span class="fmt plex">Plex digital${res.length ? ` <small>${escapeHtml(res.join(" · "))}</small>` : ""}</span>`);
    } else if (fmt.digital) {
      out.push(`<span class="fmt">Digital purchase</span>`);
    }
    if (fmt.uhd_disc) out.push(`<span class="fmt uhd">4K disc</span>`);
    if (fmt.bluray) out.push(`<span class="fmt">Blu-ray</span>`);
    if (fmt.dvd) out.push(`<span class="fmt">DVD</span>`);
    if (fmt.vhs) out.push(`<span class="fmt vhs">VHS</span>`);
    if (movieCollection(movie) === COLLECTION_VHS) out.push(`<span class="fmt dvhs">Daughter's VHS</span>`);
    else if (movieCollection(movie)) out.push(`<span class="fmt">${escapeHtml(movieCollection(movie))}</span>`);
    if (!out.length) out.push(`<span class="fmt manual">Listed — no formats marked yet</span>`);
    return out.join("");
  }

  function ownedCount(movie) {
    const f = effectiveFormats(movie);
    return (f.plex ? 1 : 0) + (f.uhd_disc ? 1 : 0) + (f.bluray ? 1 : 0) + (f.dvd ? 1 : 0) + (f.vhs ? 1 : 0) + (movie.year ? 0.5 : 0);
  }

  function needsDigital(movie) {
    return !effectiveFormats(movie).plex;
  }

  function radarrButton(term, label = "Get a digital copy in Radarr") {
    return `<a class="btn radarr" href="${escapeHtml(radarrUrl(term))}" target="_blank" rel="noopener" title="Opens Radarr on the NAS (home network or Tailscale)">${escapeHtml(label)}</a>`;
  }

  function matchingWishlist(q) {
    if (!q.tokens.length && !q.year) return [];
    return (state.wishlist.items || []).filter((w) => {
      if (state.movies.some((m) => titlesMatch(m.title, w.title))) return false;
      return searchScore({ title: w.title, year: w.year, genres: [], _wish: true }, q) > 0;
    });
  }

  let searchLimit = SEARCH_PAGE;

  function renderSearch(list) {
    const root = $("#movie-grid");
    root.className = "answer-list";
    const q = scoreCache.parsed || parseQuery(state.filters.q);
    const raw = escapeHtml(q.raw);
    const wishes = matchingWishlist(q);
    let html = "";

    if (!list.length) {
      const narrowed = hasActiveFilters() && (state.filters.formats.size || state.filters.genre || state.filters.collection || state.filters.wishlistOnly || state.filters.yearMin || state.filters.yearMax);
      html += `<div class="verdict no" role="status">
        <span class="verdict-icon">${X_SVG}</span>
        <div class="verdict-text">
          <h3>Not in the collection</h3>
          <p>Nothing we own matches “${raw}”${narrowed ? " with the current filters" : ""}. Check the spelling, or grab it in Radarr.</p>
        </div>
        ${radarrButton(q.raw, "Look it up in Radarr")}
      </div>`;
      if (narrowed) html += `<div class="more-row"><button type="button" class="btn" data-clear-filters>Search without filters</button></div>`;
    } else {
      const top = list[0];
      const topScore = queryScore(top);
      const second = list[1] ? queryScore(list[1]) : 0;
      const yearOnly = !q.tokens.length;
      const exact = topScore >= 50;
      const related = topScore < 18; // only studio / genre / collection words matched
      const strong = !yearOnly && exact && (topScore >= 60 || list.length === 1 || topScore - second >= 15);
      const label = `${escapeHtml(top.title)}${top.year ? ` (${top.year})` : ""}`;
      if (related) {
        html += `<div class="verdict no" role="status">
          <span class="verdict-icon">${X_SVG}</span>
          <div class="verdict-text">
            <h3>No title called “${raw}” in the collection</h3>
            <p>Below are ${fmtNum(list.length)} movies we own whose studio, genre or collection matches.</p>
          </div>
          ${radarrButton(q.raw, "Look it up in Radarr")}
        </div>`;
      } else html += `<div class="verdict ${exact || yearOnly ? "yes" : "maybe"}" role="status">
        <span class="verdict-icon">${CHECK_SVG}</span>
        <div class="verdict-text">
          <h3>${
            yearOnly
              ? `We own ${fmtNum(list.length)} ${list.length === 1 ? "movie" : "movies"} from ${q.year}`
              : strong
                ? `Yes — we own ${label}`
                : !exact
                  ? `Did you mean ${label}? We own it.`
                  : `We own ${fmtNum(list.length)} movies matching “${raw}”`
          }</h3>
          <p>${
            !exact && !yearOnly
              ? `No exact match for “${raw}”, so these are the closest titles we own.${list.length > 1 ? ` ${fmtNum(list.length)} close matches.` : ""}`
              : strong && list.length > 1
                ? `Plus ${fmtNum(list.length - 1)} more ${list.length - 1 === 1 ? "match" : "matches"} below.`
                : "Formats we have are listed on each title."
          }</p>
        </div>
        ${!exact && !yearOnly ? radarrButton(q.raw, "Not it? Look it up in Radarr") : ""}
      </div>`;
      html += list
        .slice(0, searchLimit)
        .map((m, i) => {
          const key = movieKey(m);
          return `<article class="own-row${i === 0 && strong ? " top" : ""}" data-key="${escapeHtml(key)}" tabindex="0" role="button" aria-label="${escapeHtml(`${m.title}${m.year ? ` (${m.year})` : ""}`)}: we own it">
            <div class="own-thumb">${artHtml(m, "w154")}</div>
            <div class="own-main">
              <h3 class="own-title">${escapeHtml(m.title)}${m.year ? `<span class="yr">${m.year}</span>` : ""}</h3>
              <p class="own-status">${CHECK_SVG}We own this${related ? ` <span class="why">· ${escapeHtml(m.studio || (m.genres || []).join(", ") || "")}</span>` : ""}</p>
              <div class="own-badges">${ownershipBadges(m)}</div>
            </div>
            <div class="own-actions">${needsDigital(m) ? radarrButton(`${m.title}${m.year ? ` ${m.year}` : ""}`) : ""}</div>
          </article>`;
        })
        .join("");
      if (list.length > searchLimit) {
        html += `<div class="more-row"><button type="button" class="btn" data-more>Show ${fmtNum(Math.min(SEARCH_PAGE, list.length - searchLimit))} more of ${fmtNum(list.length - searchLimit)}</button></div>`;
      }
    }

    if (wishes.length) {
      html += wishes
        .map(
          (w) => `<article class="own-row wish-row">
            <div class="own-thumb">${placeholderHtml(w)}</div>
            <div class="own-main">
              <h3 class="own-title">${escapeHtml(w.title)}${w.year ? `<span class="yr">${escapeHtml(w.year)}</span>` : ""}</h3>
              <p class="own-status wish">On the wishlist — not owned yet</p>
              ${w.notes ? `<div class="own-badges"><span class="fmt">${escapeHtml(w.notes)}</span></div>` : ""}
            </div>
            <div class="own-actions">${radarrButton(`${w.title}${w.year ? ` ${w.year}` : ""}`)}</div>
          </article>`
        )
        .join("");
    }
    html += `<p class="search-note">Radarr links open the NAS on your home network or Tailscale.</p>`;
    root.innerHTML = html;
  }

  function renderList() {
    const searching = !!state.filters.q.trim();
    let list = filteredMovies();
    list = searching ? list.sort((a, b) => queryScore(b) - queryScore(a) || ownedCount(b) - ownedCount(a) || sortTitle(a.title).localeCompare(sortTitle(b.title))) : sortList(list);
    renderStats(list.length);
    renderChipCounts();
    $("#btn-clear-q").hidden = !searching;
    const nFilters = activeFilterCount();
    $("#filters-count").hidden = !nFilters;
    $("#filters-count").textContent = String(nFilters);
    if (searching) {
      $("#movie-grid").classList.remove("hidden");
      $("#movie-table-wrap").classList.add("hidden");
      renderSearch(list);
      return;
    }
    $("#movie-grid").className = "poster-grid";
    if (state.view === "cards") {
      $("#movie-grid").classList.remove("hidden");
      $("#movie-table-wrap").classList.add("hidden");
      renderCards(list);
    } else {
      $("#movie-grid").classList.add("hidden");
      $("#movie-table-wrap").classList.remove("hidden");
      renderTable(list);
    }
  }

  function renderSkeleton() {
    $("#movie-grid").innerHTML = Array.from({ length: 18 })
      .map(() => `<div class="poster-card skeleton" aria-hidden="true"><div class="poster-frame"></div><div class="poster-meta"><span></span><span></span></div></div>`)
      .join("");
  }

  function renderWishlist() {
    const ul = $("#wishlist-items");
    const items = state.wishlist.items || [];
    if (!items.length) {
      ul.innerHTML = `<li class="empty-wish">Nothing on the wishlist yet.<br />Add a title above, or from any movie’s detail view.</li>`;
      return;
    }
    ul.innerHTML = items
      .map((w, i) => {
        const label = `${escapeHtml(w.title)}${w.year ? ` (${escapeHtml(w.year)})` : ""}`;
        const notes = w.notes ? `<div class="meta">${escapeHtml(w.notes)}</div>` : "";
        return `<li>
          <div><strong>${label}</strong>${notes}</div>
          <button type="button" class="btn danger" data-wish-remove="${i}">Remove</button>
        </li>`;
      })
      .join("");
  }

  let lastFocus = null;

  function openLayer(id) {
    lastFocus = document.activeElement;
    $(id).classList.remove("hidden");
    document.body.classList.add("modal-open");
    const panel = $(`${id} [tabindex="-1"]`);
    if (panel) panel.focus({ preventScroll: true });
  }

  function closeLayer(id) {
    $(id).classList.add("hidden");
    if ($$(".modal-backdrop:not(.hidden), .drawer-backdrop:not(.hidden)").length === 0) {
      document.body.classList.remove("modal-open");
    }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }

  function openModal(movie) {
    const wasOpen = !$("#modal-backdrop").classList.contains("hidden");
    state.selectedKey = movieKey(movie);
    const fmt = effectiveFormats(movie);
    const collection = movieCollection(movie);
    $("#modal-title").textContent = movie.title;

    const sub = [
      movie.year ? escapeHtml(movie.year) : null,
      movie.content_rating ? `<span class="rating">${escapeHtml(movie.content_rating)}</span>` : null,
      runtime(movie),
      movie.studio ? escapeHtml(movie.studio) : null,
      movie.animation === "live" ? "Live action" : movie.animation === "animated" ? "Animated" : null,
    ].filter(Boolean);
    $("#modal-sub").innerHTML = sub
      .map((x) => (String(x).startsWith("<span") ? x : `<span>${x}</span>`))
      .join("");

    const colEl = $("#modal-collection");
    colEl.hidden = !collection;
    colEl.textContent = collection || "";

    $("#modal-genres").innerHTML = (movie.genres || [])
      .map((g) => `<button type="button" class="pill" data-genre-jump="${escapeHtml(g)}">${escapeHtml(g)}</button>`)
      .join("");

    $("#modal-summary").textContent = movie.summary || "No synopsis yet.";

    const res = (movie.resolutions || []).map((r) => String(r).toUpperCase());
    $("#modal-res").innerHTML = fmt.plex
      ? `<span class="pill plex">On Plex</span>${res.map((r) => `<span class="pill">${escapeHtml(r)}</span>`).join("")}${isManual(movie) ? `<span class="pill manual">Manual add</span>` : ""}`
      : isManual(movie)
        ? `<span class="pill manual">Manual add</span> Not on Plex yet`
        : "Not on Plex";

    const art = $("#modal-art");
    const bd = backdropUrl(movie);
    art.className = "detail-hero" + (bd ? "" : " ph-hero");
    art.style.backgroundImage = bd ? `url("${bd}")` : "";
    art.style.setProperty("--h", titleHue(movie.title));
    $("#modal-poster").innerHTML = artHtml(movie, "w500", `${movie.title} poster`);

    const box = $("#format-toggles");
    box.innerHTML = PHYSICAL_KEYS.map((k) => {
      const on = !!fmt[k];
      return `<label class="toggle ${on ? "on" : ""}">
        <input type="checkbox" data-fmt="${k}" ${on ? "checked" : ""} />
        <span>${PHYSICAL_LABELS[k]}</span>
      </label>`;
    }).join("");

    const radarr = $("#modal-radarr");
    radarr.hidden = !needsDigital(movie);
    radarr.href = radarrUrl(`${movie.title}${movie.year ? ` ${movie.year}` : ""}`);

    const wishBtn = $("#btn-toggle-wish");
    wishBtn.textContent = isWishlisted(movie) ? "Remove from wishlist" : "Add to wishlist";
    wishBtn.dataset.mode = isWishlisted(movie) ? "remove" : "add";

    if (!wasOpen) openLayer("#modal-backdrop");
    $("#modal-backdrop .modal").scrollTop = wasOpen ? $("#modal-backdrop .modal").scrollTop : 0;
  }

  function closeModal() {
    if ($("#modal-backdrop").classList.contains("hidden")) return;
    state.selectedKey = null;
    closeLayer("#modal-backdrop");
  }

  function openAddMovieModal() {
    const form = $("#add-movie-form");
    form.reset();
    $$("#add-format-toggles .toggle").forEach((t) => t.classList.remove("on"));
    openLayer("#add-movie-backdrop");
    $("#add-title").focus();
  }

  function closeAddMovieModal() {
    if ($("#add-movie-backdrop").classList.contains("hidden")) return;
    closeLayer("#add-movie-backdrop");
  }

  function openWishlist() {
    $("#sync-menu").open = false;
    openLayer("#wishlist-backdrop");
  }

  function closeWishlist() {
    if ($("#wishlist-backdrop").classList.contains("hidden")) return;
    closeLayer("#wishlist-backdrop");
  }

  function selectedMovie() {
    return state.movies.find((m) => movieKey(m) === state.selectedKey);
  }

  function persistFormatsOverlay() {
    state.formatsOverlay.updated_at = new Date().toISOString();
    saveLS(LS_FORMATS, state.formatsOverlay);
  }

  function persistWishlist() {
    state.wishlist.updated_at = new Date().toISOString();
    saveLS(LS_WISHLIST, state.wishlist);
    renderWishlist();
    $("#stat-wishlist").textContent = String(state.wishlist.items.length);
  }

  function persistManualMovies() {
    state.manualMovies.updated_at = new Date().toISOString();
    saveLS(LS_MANUAL, state.manualMovies);
  }

  function setPhysicalFormat(key, fmtKey, value) {
    if (!state.formatsOverlay.formats[key]) state.formatsOverlay.formats[key] = {};
    state.formatsOverlay.formats[key][fmtKey] = !!value;
    // Keep overlay tidy: also clear legacy uhd4k if using uhd_disc
    if (fmtKey === "uhd_disc") delete state.formatsOverlay.formats[key].uhd4k;
    persistFormatsOverlay();

    // Keep manual movie object formats in sync when editing a manual entry
    const manual = (state.manualMovies.movies || []).find((m) => movieKey(m) === key);
    if (manual) {
      if (!manual.formats) manual.formats = {};
      if (fmtKey === "plex") manual.formats.plex = !!value;
      else manual.formats[fmtKey] = !!value;
      persistManualMovies();
      const live = state.movies.find((m) => movieKey(m) === key);
      if (live && live.formats) live.formats[fmtKey] = !!value;
    }
  }

  function mergeManualLists(serverManual, localManual) {
    const byId = new Map();
    for (const m of serverManual.movies || []) {
      const id = m.id || manualId(m.title, m.year);
      byId.set(id, { ...m, id, source: "manual" });
    }
    // local wins for same id
    for (const m of localManual.movies || []) {
      const id = m.id || manualId(m.title, m.year);
      byId.set(id, { ...m, id, source: "manual" });
    }
    return {
      updated_at: localManual.updated_at || serverManual.updated_at || null,
      note: serverManual.note || localManual.note,
      movies: [...byId.values()],
    };
  }

  function rebuildMovieList(plexMovies) {
    const plex = (plexMovies || []).map((m) => ({ ...m }));
    const plexKeys = new Set(plex.map((m) => movieKey(m)));
    const manuals = (state.manualMovies.movies || []).filter((m) => {
      const id = m.id || manualId(m.title, m.year);
      // skip manual that collides with plex key (shouldn't happen with manual- prefix)
      return !plexKeys.has(id);
    });
    // Also drop manuals whose title+year already exist on Plex — keep Plex row;
    // formats for those should live in formats-overlay only.
    const filteredManuals = manuals.filter((m) => {
      const hit = plex.find(
        (p) => titlesMatch(p.title, m.title) && Number(p.year || 0) === Number(m.year || 0)
      );
      return !hit;
    });
    state.movies = [...plex, ...filteredManuals.map((m) => ({ ...m, source: "manual" }))];
  }

  function mergeServerOverlays(serverFormats, serverWishlist, serverManual) {
    // Server committed files are baseline; localStorage wins for newer edits.
    const localF = loadLS(LS_FORMATS, { formats: {} });
    const mergedFormats = {
      updated_at: localF.updated_at || serverFormats.updated_at || null,
      note: serverFormats.note,
      formats: { ...(serverFormats.formats || {}), ...(localF.formats || {}) },
    };

    const localW = loadLS(LS_WISHLIST, { items: [] });
    let wishlist;
    if (localW.items && localW.items.length) {
      wishlist = localW;
    } else {
      wishlist = serverWishlist.items ? serverWishlist : { items: [] };
      if (wishlist.items?.length) saveLS(LS_WISHLIST, wishlist);
    }

    if (Object.keys(localF.formats || {}).length === 0 && Object.keys(serverFormats.formats || {}).length) {
      saveLS(LS_FORMATS, mergedFormats);
    }

    const localM = loadLS(LS_MANUAL, { movies: [] });
    const mergedManual = mergeManualLists(serverManual || { movies: [] }, localM);
    if (!(localM.movies || []).length && (serverManual.movies || []).length) {
      saveLS(LS_MANUAL, mergedManual);
    }

    state.formatsOverlay = mergedFormats;
    state.wishlist = wishlist;
    state.manualMovies = mergedManual;
  }

  function readAddFormFormats() {
    const formats = {
      plex: false,
      uhd_disc: false,
      bluray: false,
      dvd: false,
      vhs: false,
      digital: false,
    };
    $$("#add-format-toggles input[data-fmt]").forEach((input) => {
      formats[input.dataset.fmt] = !!input.checked;
    });
    return formats;
  }

  function applyFormatsToExisting(movie, formats) {
    const key = movieKey(movie);
    if (!state.formatsOverlay.formats[key]) state.formatsOverlay.formats[key] = {};
    const over = state.formatsOverlay.formats[key];
    for (const k of [...PHYSICAL_KEYS, "plex"]) {
      if (formats[k]) over[k] = true;
    }
    if (formats.uhd_disc) delete over.uhd4k;
    persistFormatsOverlay();
    // Also merge onto movie.formats for immediate display when plex base is empty
    if (!movie.formats) movie.formats = {};
    for (const k of PHYSICAL_KEYS) {
      if (formats[k]) movie.formats[k] = true;
    }
    if (formats.plex) movie.formats.plex = true;
  }

  function upsertManualMovie(entry) {
    const id = entry.id;
    const list = state.manualMovies.movies || (state.manualMovies.movies = []);
    const idx = list.findIndex((m) => (m.id || manualId(m.title, m.year)) === id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    persistManualMovies();
  }

  function handleAddMovieSubmit(e) {
    e.preventDefault();
    const title = $("#add-title").value.trim();
    if (!title) return;
    const yearRaw = $("#add-year").value.trim();
    const year = yearRaw ? Number(yearRaw) : null;
    const studio = $("#add-studio").value.trim() || null;
    const genres = $("#add-genres")
      .value.split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    const animation = $("#add-animation").value || null;
    const asWishlist = $("#add-as-wishlist").checked;
    const formats = readAddFormFormats();

    if (asWishlist) {
      const existsWish = state.wishlist.items.some((w) => {
        if (!titlesMatch(w.title, title)) return false;
        if (year && w.year && Number(w.year) !== Number(year)) return false;
        return true;
      });
      if (!existsWish) {
        state.wishlist.items.push({
          id: `wl-${Date.now()}`,
          title,
          year: year || null,
          notes: "Manual add (wishlist)",
        });
        persistWishlist();
      }
      closeAddMovieModal();
      renderList();
      toast("Added to wishlist (local). Download wishlist JSON to commit.");
      return;
    }

    const existing = findByTitleYear(title, year);
    if (existing) {
      const fromPlex = !!existing.plex_rating_key && existing.source !== "manual";
      const msg = fromPlex
        ? `"${title}" (${year || "—"}) is already in the Plex catalog. Update formats on the existing entry instead of duplicating?`
        : `"${title}" (${year || "—"}) already exists. Update formats on the existing entry instead of duplicating?`;
      if (window.confirm(msg)) {
        applyFormatsToExisting(existing, formats);
        if (animation && existing.source === "manual") {
          existing.animation = animation;
          const mid = existing.id || manualId(existing.title, existing.year);
          const stored = (state.manualMovies.movies || []).find((m) => (m.id || "") === mid);
          if (stored) {
            stored.animation = animation;
            if (studio) stored.studio = studio;
            if (genres.length) stored.genres = genres;
            persistManualMovies();
          }
        }
        closeAddMovieModal();
        renderList();
        openModal(existing);
        toast("Formats updated on existing movie — download overlay JSON to commit.");
        return;
      }
      toast("Add cancelled — existing title left unchanged.");
      return;
    }

    const id = manualId(title, year);
    const entry = {
      id,
      title,
      year: year || null,
      studio,
      genres,
      animation,
      summary: "",
      content_rating: null,
      resolutions: [],
      section: "Manual",
      source: "manual",
      formats: {
        plex: !!formats.plex,
        bluray: !!formats.bluray,
        dvd: !!formats.dvd,
        vhs: !!formats.vhs,
        digital: !!formats.digital,
        uhd_disc: !!formats.uhd_disc,
        uhd4k: false,
      },
      added_at: String(Math.floor(Date.now() / 1000)),
    };
    upsertManualMovie(entry);
    // Seed formats overlay so downloadable overlay includes manual ownership too
    applyFormatsToExisting(entry, formats);
    state.movies.push({ ...entry });
    invalidateSearch();
    renderGenreOptions();
    closeAddMovieModal();
    renderList();
    toast("Movie saved locally — download manual-movies.json to commit.");
  }

  async function loadData() {
    const [moviesRes, formatsRes, wishRes, manualRes, postersRes] = await Promise.all([
      fetch("data/movies.json"),
      fetch("data/formats-overlay.json"),
      fetch("data/wishlist.json"),
      fetch("data/manual-movies.json"),
      fetch("data/posters.json").catch(() => null),
    ]);
    if (!moviesRes.ok) throw new Error("Failed to load data/movies.json");
    const moviesData = await moviesRes.json();
    const formatsData = formatsRes.ok ? await formatsRes.json() : { formats: {} };
    const wishData = wishRes.ok ? await wishRes.json() : { items: [] };
    const manualData = manualRes.ok ? await manualRes.json() : { movies: [] };
    try {
      state.posters = postersRes && postersRes.ok ? (await postersRes.json()).posters || {} : {};
    } catch {
      state.posters = {};
    }

    state.meta = {
      source: moviesData.source,
      imported_at: moviesData.imported_at,
      movie_count: moviesData.movie_count,
    };
    mergeServerOverlays(formatsData, wishData, manualData);
    rebuildMovieList(moviesData.movies || []);
  }

  function clearFilters() {
    state.filters = { q: "", genre: "", yearMin: "", yearMax: "", formats: new Set(), wishlistOnly: false, collection: "" };
    $("#filter-q").value = "";
    $("#filter-year-min").value = "";
    $("#filter-year-max").value = "";
    syncChipStates();
    renderList();
  }

  function syncChipStates() {
    const f = state.filters;
    const set = (chip, on) => {
      chip.classList.toggle("active", on);
      chip.setAttribute("aria-pressed", String(on));
    };
    $$(".chip[data-format]").forEach((c) => set(c, f.formats.has(c.dataset.format)));
    set($("#chip-collection"), f.collection === $("#chip-collection").dataset.collection);
    set($("#chip-wishlist"), f.wishlistOnly);
    $$("#genre-chips .chip[data-genre]").forEach((c) => set(c, c.dataset.genre === f.genre));
  }

  function bind() {
    let qTimer;
    $("#filter-q").addEventListener("input", (e) => {
      state.filters.q = e.target.value;
      searchLimit = SEARCH_PAGE;
      $("#btn-clear-q").hidden = !e.target.value.trim();
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        renderList();
        if (window.scrollY > 0) window.scrollTo({ top: 0 });
      }, 60);
    });
    $("#filter-q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = $("#movie-grid .own-row[data-key]");
        if (first) first.focus();
      } else if (e.key === "Escape" && e.target.value) {
        e.stopPropagation();
        e.target.value = "";
        state.filters.q = "";
        renderList();
      }
    });
    $("#btn-clear-q").addEventListener("click", () => {
      $("#filter-q").value = "";
      state.filters.q = "";
      renderList();
      $("#filter-q").focus();
    });
    $("#btn-filters").addEventListener("click", () => {
      const bar = $("#filterbar");
      bar.hidden = !bar.hidden;
      $("#btn-filters").setAttribute("aria-expanded", String(!bar.hidden));
    });
    $("#genre-chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-genre]");
      if (!chip) return;
      const g = chip.dataset.genre;
      state.filters.genre = state.filters.genre === g ? "" : g;
      syncChipStates();
      renderList();
    });
    $("#filter-year-min").addEventListener("input", (e) => {
      state.filters.yearMin = e.target.value;
      renderList();
    });
    $("#filter-year-max").addEventListener("input", (e) => {
      state.filters.yearMax = e.target.value;
      renderList();
    });
    $("#sort-by").addEventListener("change", (e) => {
      state.sort = e.target.value;
      renderList();
    });

    $$(".chip[data-format]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const f = chip.dataset.format;
        if (state.filters.formats.has(f)) state.filters.formats.delete(f);
        else state.filters.formats.add(f);
        syncChipStates();
        renderList();
      });
    });

    $("#chip-wishlist").addEventListener("click", () => {
      state.filters.wishlistOnly = !state.filters.wishlistOnly;
      syncChipStates();
      renderList();
    });

    const collectionChip = $("#chip-collection");
    collectionChip.addEventListener("click", () => {
      const value = collectionChip.dataset.collection;
      state.filters.collection = state.filters.collection !== value ? value : "";
      syncChipStates();
      renderList();
    });

    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-clear]")) clearFilters();
      if (e.target.closest("[data-clear-filters]")) {
        const q = state.filters.q;
        clearFilters();
        state.filters.q = q;
        $("#filter-q").value = q;
        renderList();
      }
      if (e.target.closest("[data-more]")) {
        searchLimit += SEARCH_PAGE;
        renderList();
      }
      const menu = $("#sync-menu");
      if (menu.open && !e.target.closest("#sync-menu")) menu.open = false;
    });

    $$(".view-toggle .seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.view = btn.dataset.view;
        $$(".view-toggle .seg").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-pressed", String(b === btn));
        });
        renderList();
      });
    });

    // Fade posters in once loaded (load events don't bubble; use capture).
    const markLoaded = (e) => {
      if (e.target.tagName === "IMG") e.target.classList.add("loaded");
    };
    document.addEventListener("load", markLoaded, true);
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (img.tagName !== "IMG" || !img.closest(".poster-frame, .detail-poster, .thumb")) return;
      const card = img.closest("[data-key]");
      const key = card ? card.dataset.key : state.selectedKey;
      const m = state.movies.find((x) => movieKey(x) === key);
      if (m) img.outerHTML = placeholderHtml(m);
    }, true);

    $("#modal-genres").addEventListener("click", (e) => {
      const g = e.target.closest("[data-genre-jump]");
      if (!g) return;
      state.filters.genre = g.dataset.genreJump;
      closeModal();
      syncChipStates();
      renderList();
      const chip = $(`#genre-chips .chip[data-genre="${CSS.escape(state.filters.genre)}"]`);
      if (chip) chip.scrollIntoView({ inline: "center", block: "nearest" });
      window.scrollTo({ top: $("#main").offsetTop - $("#filterbar").offsetHeight - $("#topbar").offsetHeight, behavior: "smooth" });
    });

    $("#btn-open-wishlist").addEventListener("click", openWishlist);
    $("#wishlist-close").addEventListener("click", closeWishlist);
    $("#wishlist-backdrop").addEventListener("click", (e) => {
      if (e.target === $("#wishlist-backdrop")) closeWishlist();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !e.target.closest("input, textarea, select") && $$(".modal-backdrop:not(.hidden), .drawer-backdrop:not(.hidden)").length === 0) {
        e.preventDefault();
        $("#filter-q").focus();
      }
    });

    const onScroll = () => {
      const y = window.scrollY;
      if (y > 140) document.body.classList.add("compact");
      else if (y < 10) document.body.classList.remove("compact");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const syncTopbar = () => document.documentElement.style.setProperty("--topbar-h", `${$("#topbar").offsetHeight}px`);
    window.addEventListener("resize", syncTopbar);
    syncTopbar();

    $("#movie-grid").addEventListener("click", (e) => {
      if (e.target.closest("a, button")) return;
      const card = e.target.closest("[data-key]");
      if (!card) return;
      const m = state.movies.find((x) => movieKey(x) === card.dataset.key);
      if (m) openModal(m);
    });
    $("#movie-grid").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("a, button")) return;
      const card = e.target.closest("[data-key]");
      if (!card) return;
      e.preventDefault();
      const m = state.movies.find((x) => movieKey(x) === card.dataset.key);
      if (m) openModal(m);
    });
    $("#movie-table-body").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const row = e.target.closest("[data-key]");
      const m = row && state.movies.find((x) => movieKey(x) === row.dataset.key);
      if (m) openModal(m);
    });
    $("#movie-table-body").addEventListener("click", (e) => {
      const row = e.target.closest("[data-key]");
      if (!row) return;
      const m = state.movies.find((x) => movieKey(x) === row.dataset.key);
      if (m) openModal(m);
    });

    $("#modal-close").addEventListener("click", closeModal);
    $("#modal-backdrop").addEventListener("click", (e) => {
      if (e.target === $("#modal-backdrop")) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("#sync-menu").open) {
        $("#sync-menu").open = false;
        return;
      }
      if (!$("#add-movie-backdrop").classList.contains("hidden")) {
        closeAddMovieModal();
        return;
      }
      if (!$("#wishlist-backdrop").classList.contains("hidden")) {
        closeWishlist();
        return;
      }
      closeModal();
    });

    $("#format-toggles").addEventListener("change", (e) => {
      const input = e.target.closest("input[data-fmt]");
      if (!input || !state.selectedKey) return;
      setPhysicalFormat(state.selectedKey, input.dataset.fmt, input.checked);
      input.closest(".toggle").classList.toggle("on", input.checked);
      renderList();
      toast("Format saved locally — download overlay JSON to commit.");
    });

    $("#btn-toggle-wish").addEventListener("click", () => {
      const m = selectedMovie();
      if (!m) return;
      const title = m.title;
      const year = m.year;
      if ($("#btn-toggle-wish").dataset.mode === "remove") {
        state.wishlist.items = state.wishlist.items.filter((w) => {
          if ((w.title || "").toLowerCase() !== title.toLowerCase()) return true;
          if (w.year && year && Number(w.year) !== Number(year)) return true;
          return false;
        });
        toast("Removed from wishlist");
      } else {
        state.wishlist.items.push({
          id: `wl-${Date.now()}`,
          title,
          year: year || null,
          notes: "From catalog",
        });
        toast("Added to wishlist");
      }
      persistWishlist();
      openModal(m);
      renderList();
    });

    $("#btn-download-formats").addEventListener("click", () => {
      const payload = {
        updated_at: new Date().toISOString(),
        note: "Physical ownership overlays keyed by plex_rating_key (or manual id). uhd_disc = owned 4K UHD disc (separate from Plex file resolution). Optional collection (e.g. Daughter's VHS) marks who owns the physical copy.",
        formats: state.formatsOverlay.formats || {},
      };
      downloadJson("formats-overlay.json", payload);
      $("#sync-menu").open = false;
      toast("Downloaded formats-overlay.json — replace data/formats-overlay.json and commit.");
    });

    $("#btn-download-wishlist").addEventListener("click", () => {
      const payload = {
        updated_at: new Date().toISOString(),
        items: state.wishlist.items || [],
      };
      downloadJson("wishlist.json", payload);
      $("#sync-menu").open = false;
      toast("Downloaded wishlist.json — replace data/wishlist.json and commit.");
    });

    $("#btn-download-manual").addEventListener("click", () => {
      const payload = {
        updated_at: new Date().toISOString(),
        note: "Manually added movies not (yet) in Plex. Merged with movies.json on load. Ids are manual-<slug>-<year>; localStorage wins for the same id.",
        movies: state.manualMovies.movies || [],
      };
      downloadJson("manual-movies.json", payload);
      $("#sync-menu").open = false;
      toast("Downloaded manual-movies.json — replace data/manual-movies.json and commit.");
    });

    $("#btn-export-modal-formats").addEventListener("click", () => {
      $("#btn-download-formats").click();
    });

    $("#btn-add-movie").addEventListener("click", openAddMovieModal);
    $("#add-movie-close").addEventListener("click", closeAddMovieModal);
    $("#add-movie-cancel").addEventListener("click", closeAddMovieModal);
    $("#add-movie-backdrop").addEventListener("click", (e) => {
      if (e.target === $("#add-movie-backdrop")) closeAddMovieModal();
    });
    $("#add-movie-form").addEventListener("submit", handleAddMovieSubmit);
    $("#add-format-toggles").addEventListener("change", (e) => {
      const input = e.target.closest("input[data-fmt]");
      if (!input) return;
      input.closest(".toggle").classList.toggle("on", input.checked);
    });

    $("#wishlist-add").addEventListener("submit", (e) => {
      e.preventDefault();
      const title = $("#wish-title").value.trim();
      if (!title) return;
      const yearRaw = $("#wish-year").value.trim();
      const notes = $("#wish-notes").value.trim();
      state.wishlist.items.push({
        id: `wl-${Date.now()}`,
        title,
        year: yearRaw ? Number(yearRaw) : null,
        notes,
      });
      persistWishlist();
      e.target.reset();
      toast("Wishlist item added (local). Download JSON to commit.");
      renderList();
    });

    $("#wishlist-items").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-wish-remove]");
      if (!btn) return;
      const idx = Number(btn.dataset.wishRemove);
      state.wishlist.items.splice(idx, 1);
      persistWishlist();
      renderList();
      toast("Removed wishlist item");
    });
  }

  async function init() {
    bind();
    renderSkeleton();
    try {
      await loadData();
      renderGenreOptions();
      renderWishlist();
      renderList();
      $("#source-name").textContent = state.meta.source || "Plex";
      const params = new URLSearchParams(location.search);
      if (params.get("q")) {
        $("#filter-q").value = params.get("q");
        state.filters.q = params.get("q");
        renderList();
      }
      if (!matchMedia("(hover: none)").matches) $("#filter-q").focus();
    } catch (err) {
      console.error(err);
      $("#movie-grid").innerHTML = `<div class="empty"><h3>Couldn’t load the library</h3><p>Check that <code>data/movies.json</code> is reachable, then refresh.</p></div>`;
      toast(String(err.message || err));
    }
  }

  init();
})();
