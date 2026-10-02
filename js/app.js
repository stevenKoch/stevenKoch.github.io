(() => {
  "use strict";

  const LS_FORMATS = "kochMovieDb.formatsOverlay.v1";
  const LS_WISHLIST = "kochMovieDb.wishlist.v1";

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
    filters: {
      q: "",
      genre: "",
      yearMin: "",
      yearMax: "",
      formats: new Set(),
      wishlistOnly: false,
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
    return String(m.plex_rating_key || `${m.title}|${m.year || ""}`);
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

  /** Merge base Plex formats with physical overlay. */
  function effectiveFormats(movie) {
    const base = movie.formats || {};
    const over = state.formatsOverlay.formats[movieKey(movie)] || {};
    return {
      plex: !!base.plex,
      // Plex file 4K (resolution) — not physical disc
      plex_4k_file: !!base.uhd4k || (movie.resolutions || []).some((r) => String(r).toLowerCase() === "4k"),
      digital: over.digital != null ? !!over.digital : !!base.digital,
      bluray: over.bluray != null ? !!over.bluray : !!base.bluray,
      dvd: over.dvd != null ? !!over.dvd : !!base.dvd,
      vhs: over.vhs != null ? !!over.vhs : !!base.vhs,
      uhd_disc: over.uhd_disc != null ? !!over.uhd_disc : !!over.uhd4k, // allow old key
    };
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
      const hay = `${movie.title} ${movie.studio || ""} ${(movie.genres || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.genre && !(movie.genres || []).includes(f.genre)) return false;
    if (f.yearMin && (movie.year == null || movie.year < Number(f.yearMin))) return false;
    if (f.yearMax && (movie.year == null || movie.year > Number(f.yearMax))) return false;
    if (f.wishlistOnly && !isWishlisted(movie)) return false;

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
    if (fmt.plex) bits.push(`<span class="badge plex">On Plex</span>`);
    for (const r of movie.resolutions || []) {
      bits.push(`<span class="badge res">${escapeHtml(String(r).toUpperCase())}</span>`);
    }
    if (fmt.uhd_disc) bits.push(`<span class="badge disc">4K Disc</span>`);
    if (fmt.bluray) bits.push(`<span class="badge disc">Blu-ray</span>`);
    if (fmt.dvd) bits.push(`<span class="badge disc">DVD</span>`);
    if (fmt.vhs) bits.push(`<span class="badge disc">VHS</span>`);
    if (fmt.digital) bits.push(`<span class="badge disc">Digital</span>`);
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
      movie.content_rating || null,
    ]
      .filter(Boolean)
      .join(" · ");
    $("#modal-summary").textContent = movie.summary || "No synopsis available.";
    $("#modal-res").textContent = (movie.resolutions || []).length
      ? `Plex file resolution: ${(movie.resolutions || []).join(", ").toUpperCase()}`
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

  function setPhysicalFormat(key, fmtKey, value) {
    if (!state.formatsOverlay.formats[key]) state.formatsOverlay.formats[key] = {};
    state.formatsOverlay.formats[key][fmtKey] = !!value;
    // Keep overlay tidy: also clear legacy uhd4k if using uhd_disc
    if (fmtKey === "uhd_disc") delete state.formatsOverlay.formats[key].uhd4k;
    persistFormatsOverlay();
  }

  function mergeServerOverlays(serverFormats, serverWishlist) {
    // Server committed files are baseline; localStorage wins for newer edits.
    const localF = loadLS(LS_FORMATS, { formats: {} });
    const mergedFormats = {
      updated_at: localF.updated_at || serverFormats.updated_at || null,
      note: serverFormats.note,
      formats: { ...(serverFormats.formats || {}), ...(localF.formats || {}) },
    };
    // If server is newer for a key not in local, already covered by spread order.
    // Prefer local entirely for keys present locally (already done).

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

    state.formatsOverlay = mergedFormats;
    state.wishlist = wishlist;
  }

  async function loadData() {
    const [moviesRes, formatsRes, wishRes] = await Promise.all([
      fetch("data/movies.json"),
      fetch("data/formats-overlay.json"),
      fetch("data/wishlist.json"),
    ]);
    if (!moviesRes.ok) throw new Error("Failed to load data/movies.json");
    const moviesData = await moviesRes.json();
    const formatsData = formatsRes.ok ? await formatsRes.json() : { formats: {} };
    const wishData = wishRes.ok ? await wishRes.json() : { items: [] };

    state.meta = {
      source: moviesData.source,
      imported_at: moviesData.imported_at,
      movie_count: moviesData.movie_count,
    };
    state.movies = moviesData.movies || [];
    mergeServerOverlays(formatsData, wishData);
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

    $("#btn-clear").addEventListener("click", () => {
      state.filters = { q: "", genre: "", yearMin: "", yearMax: "", formats: new Set(), wishlistOnly: false };
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
      if (e.key === "Escape") closeModal();
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
        note: "Physical ownership overlays keyed by plex_rating_key. uhd_disc = owned 4K UHD disc (separate from Plex file resolution).",
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

    $("#btn-export-modal-formats").addEventListener("click", () => {
      $("#btn-download-formats").click();
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
