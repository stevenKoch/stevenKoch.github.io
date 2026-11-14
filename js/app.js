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
    view: "cards",
    selectedKey: null,
  };

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
    const q = f.q.trim().toLowerCase();
    if (q) {
      const hay = `${movie.title} ${movie.studio || ""} ${(movie.genres || []).join(" ")} ${movieCollection(movie) || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
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

  function formatBadges(movie) {
    const fmt = effectiveFormats(movie);
    const bits = [];
    if (movie.source === "manual" || (movie.id && String(movie.id).startsWith("manual-"))) {
      bits.push(`<span class="badge manual">Manual</span>`);
    }
    if (fmt.plex) bits.push(`<span class="badge plex">On Plex</span>`);
    for (const r of movie.resolutions || []) {
      bits.push(`<span class="badge res">${escapeHtml(String(r).toUpperCase())}</span>`);
    }
    if (fmt.uhd_disc) bits.push(`<span class="badge disc">4K Disc</span>`);
    if (fmt.bluray) bits.push(`<span class="badge disc">Blu-ray</span>`);
    if (fmt.dvd) bits.push(`<span class="badge disc">DVD</span>`);
    if (fmt.vhs) bits.push(`<span class="badge disc">VHS</span>`);
    if (fmt.digital) bits.push(`<span class="badge disc">Digital</span>`);
    if (movie.animation === "live") bits.push(`<span class="badge anim">Live</span>`);
    if (movie.animation === "animated") bits.push(`<span class="badge anim">Animated</span>`);
    const collection = movieCollection(movie);
    if (collection) bits.push(`<span class="badge collection">${escapeHtml(collection)}</span>`);
    if (isWishlisted(movie)) bits.push(`<span class="badge wish">Wishlist</span>`);
    return bits.join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderStats() {
    const total = state.movies.length;
    const shown = filteredMovies().length;
    const physical = state.movies.filter((m) => {
      const f = effectiveFormats(m);
      return f.uhd_disc || f.bluray || f.dvd || f.vhs;
    }).length;
    $("#stat-total").textContent = String(total);
    $("#stat-shown").textContent = String(shown);
    $("#stat-physical").textContent = String(physical);
    $("#stat-wishlist").textContent = String(state.wishlist.items.length);
    const imported = state.meta.imported_at || "—";
    $("#stat-imported").textContent = imported;
    $("#result-count").textContent = `${shown} of ${total} movies`;
  }

  function renderGenreOptions() {
    const genres = new Set();
    state.movies.forEach((m) => (m.genres || []).forEach((g) => genres.add(g)));
    const sel = $("#filter-genre");
    const current = sel.value;
    sel.innerHTML =
      `<option value="">All genres</option>` +
      [...genres]
        .sort((a, b) => a.localeCompare(b))
        .map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`)
        .join("");
    sel.value = current;
  }

  function renderCards(list) {
    const root = $("#movie-grid");
    if (!list.length) {
      root.innerHTML = `<div class="empty">No movies match these filters.</div>`;
      return;
    }
    root.innerHTML = list
      .map((m) => {
        const key = movieKey(m);
        return `<article class="card" data-key="${escapeHtml(key)}" tabindex="0" role="button">
          <div class="year">${m.year || "—"}</div>
          <h3>${escapeHtml(m.title)}</h3>
          <div class="badges">${formatBadges(m)}</div>
          <p class="summary">${escapeHtml(m.summary || "No synopsis.")}</p>
        </article>`;
      })
      .join("");
  }

  function renderTable(list) {
    const body = $("#movie-table-body");
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">No movies match these filters.</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((m) => {
        const key = movieKey(m);
        const genres = (m.genres || []).join(", ");
        return `<tr data-key="${escapeHtml(key)}">
          <td class="title">${escapeHtml(m.title)}</td>
          <td>${m.year || "—"}</td>
          <td>${escapeHtml(genres || "—")}</td>
          <td>${escapeHtml(m.studio || "—")}</td>
          <td>${escapeHtml((m.resolutions || []).join(", ") || "—")}</td>
          <td><div class="badges">${formatBadges(m)}</div></td>
        </tr>`;
      })
      .join("");
  }

  function renderList() {
    const list = filteredMovies();
    renderStats();
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

  function renderWishlist() {
    const ul = $("#wishlist-items");
    const items = state.wishlist.items || [];
    if (!items.length) {
      ul.innerHTML = `<li class="meta">Wishlist is empty. Add titles you want to own.</li>`;
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

  function openModal(movie) {
    state.selectedKey = movieKey(movie);
    const fmt = effectiveFormats(movie);
    $("#modal-title").textContent = movie.title;
    $("#modal-sub").textContent = [
      movie.year || null,
      movie.studio || null,
      (movie.genres || []).join(" · ") || null,
      movie.animation === "live" ? "Live action" : movie.animation === "animated" ? "Animated" : null,
      movie.content_rating || null,
      movieCollection(movie) || null,
      movie.source === "manual" ? "Manual add" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    $("#modal-summary").textContent = movie.summary || "No synopsis available.";
    $("#modal-res").textContent = (movie.resolutions || []).length
      ? `Plex file resolution: ${(movie.resolutions || []).join(", ").toUpperCase()}`
      : movie.source === "manual"
        ? "Not on Plex yet (manual entry)."
        : "Plex file resolution: unknown";

    const box = $("#format-toggles");
    box.innerHTML = PHYSICAL_KEYS.map((k) => {
      const on = !!fmt[k];
      return `<label class="toggle ${on ? "on" : ""}">
        <input type="checkbox" data-fmt="${k}" ${on ? "checked" : ""} />
        <span>${PHYSICAL_LABELS[k]}</span>
      </label>`;
    }).join("");

    const wishBtn = $("#btn-toggle-wish");
    wishBtn.textContent = isWishlisted(movie) ? "Remove from wishlist" : "Add to wishlist";
    wishBtn.dataset.mode = isWishlisted(movie) ? "remove" : "add";

    $("#modal-backdrop").classList.remove("hidden");
  }

  function closeModal() {
    state.selectedKey = null;
    $("#modal-backdrop").classList.add("hidden");
  }

  function openAddMovieModal() {
    const form = $("#add-movie-form");
    form.reset();
    $$("#add-format-toggles .toggle").forEach((t) => t.classList.remove("on"));
    $("#add-movie-backdrop").classList.remove("hidden");
    $("#add-title").focus();
  }

  function closeAddMovieModal() {
    $("#add-movie-backdrop").classList.add("hidden");
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
    renderStats();
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
    renderGenreOptions();
    closeAddMovieModal();
    renderList();
    toast("Movie saved locally — download manual-movies.json to commit.");
  }

  async function loadData() {
    const [moviesRes, formatsRes, wishRes, manualRes] = await Promise.all([
      fetch("data/movies.json"),
      fetch("data/formats-overlay.json"),
      fetch("data/wishlist.json"),
      fetch("data/manual-movies.json"),
    ]);
    if (!moviesRes.ok) throw new Error("Failed to load data/movies.json");
    const moviesData = await moviesRes.json();
    const formatsData = formatsRes.ok ? await formatsRes.json() : { formats: {} };
    const wishData = wishRes.ok ? await wishRes.json() : { items: [] };
    const manualData = manualRes.ok ? await manualRes.json() : { movies: [] };

    state.meta = {
      source: moviesData.source,
      imported_at: moviesData.imported_at,
      movie_count: moviesData.movie_count,
    };
    mergeServerOverlays(formatsData, wishData, manualData);
    rebuildMovieList(moviesData.movies || []);
  }

  function bind() {
    $("#filter-q").addEventListener("input", (e) => {
      state.filters.q = e.target.value;
      renderList();
    });
    $("#filter-genre").addEventListener("change", (e) => {
      state.filters.genre = e.target.value;
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

    $$(".chip[data-format]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const f = chip.dataset.format;
        if (state.filters.formats.has(f)) {
          state.filters.formats.delete(f);
          chip.classList.remove("active");
        } else {
          state.filters.formats.add(f);
          chip.classList.add("active");
        }
        renderList();
      });
    });

    $("#chip-wishlist").addEventListener("click", () => {
      state.filters.wishlistOnly = !state.filters.wishlistOnly;
      $("#chip-wishlist").classList.toggle("active", state.filters.wishlistOnly);
      renderList();
    });

    const collectionChip = $("#chip-collection");
    if (collectionChip) {
      collectionChip.addEventListener("click", () => {
        const value = collectionChip.dataset.collection;
        const on = state.filters.collection !== value;
        state.filters.collection = on ? value : "";
        collectionChip.classList.toggle("active", on);
        renderList();
      });
    }

    $("#btn-clear").addEventListener("click", () => {
      state.filters = { q: "", genre: "", yearMin: "", yearMax: "", formats: new Set(), wishlistOnly: false, collection: "" };
      $("#filter-q").value = "";
      $("#filter-genre").value = "";
      $("#filter-year-min").value = "";
      $("#filter-year-max").value = "";
      $$(".chip").forEach((c) => c.classList.remove("active"));
      renderList();
    });

    $$(".view-toggle .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.view = btn.dataset.view;
        $$(".view-toggle .btn").forEach((b) => b.classList.toggle("active", b === btn));
        renderList();
      });
    });

    $("#movie-grid").addEventListener("click", (e) => {
      const card = e.target.closest("[data-key]");
      if (!card) return;
      const m = state.movies.find((x) => movieKey(x) === card.dataset.key);
      if (m) openModal(m);
    });
    $("#movie-grid").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest("[data-key]");
      if (!card) return;
      e.preventDefault();
      const m = state.movies.find((x) => movieKey(x) === card.dataset.key);
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
      if (!$("#add-movie-backdrop").classList.contains("hidden")) {
        closeAddMovieModal();
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
      toast("Downloaded formats-overlay.json — replace data/formats-overlay.json and commit.");
    });

    $("#btn-download-wishlist").addEventListener("click", () => {
      const payload = {
        updated_at: new Date().toISOString(),
        items: state.wishlist.items || [],
      };
      downloadJson("wishlist.json", payload);
      toast("Downloaded wishlist.json — replace data/wishlist.json and commit.");
    });

    $("#btn-download-manual").addEventListener("click", () => {
      const payload = {
        updated_at: new Date().toISOString(),
        note: "Manually added movies not (yet) in Plex. Merged with movies.json on load. Ids are manual-<slug>-<year>; localStorage wins for the same id.",
        movies: state.manualMovies.movies || [],
      };
      downloadJson("manual-movies.json", payload);
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
    try {
      await loadData();
      renderGenreOptions();
      renderWishlist();
      renderList();
      $("#source-name").textContent = state.meta.source || "Plex";
    } catch (err) {
      console.error(err);
      $("#movie-grid").innerHTML = `<div class="empty">Failed to load movie data. Check data/movies.json.</div>`;
      toast(String(err.message || err));
    }
  }

  init();
})();
