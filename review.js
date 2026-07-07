// Face-first name reviewer (Phase 4a). Pulls the read-only roster bundle the
// laptop publishes (review/roster.json + review/faces/*), caches it offline in
// its own IndexedDB, and drills faces with a transparent SM-2 schedule.
// SRS state lives here on the phone only — never in the Excel (per spec §3.6).
const REVIEW = (() => {
  const $ = (id) => document.getElementById(id);

  // --- storage --------------------------------------------------------------
  const RDB = (() => {
    const NAME = "card-review";
    let _db = null;
    function open() {
      return new Promise((resolve, reject) => {
        if (_db) return resolve(_db);
        const req = indexedDB.open(NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("roster")) db.createObjectStore("roster", { keyPath: "id" });
          if (!db.objectStoreNames.contains("faces")) db.createObjectStore("faces");   // key = filename
          if (!db.objectStoreNames.contains("srs")) db.createObjectStore("srs", { keyPath: "id" });
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror = () => reject(req.error);
      });
    }
    const tx = (store, mode) => open().then((db) => db.transaction(store, mode).objectStore(store));
    const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    return {
      async putRoster(list) {
        const s = await tx("roster", "readwrite");
        await Promise.all([p(s.clear())]);
        const s2 = await tx("roster", "readwrite");
        for (const r of list) s2.put(r);
        return new Promise((res) => { s2.transaction.oncomplete = () => res(); });
      },
      async roster() { return p((await tx("roster", "readonly")).getAll()) || []; },
      async putFace(fn, blob) { const s = await tx("faces", "readwrite"); return p(s.put(blob, fn)); },
      async face(fn) { return p((await tx("faces", "readonly")).get(fn)); },
      async hasFace(fn) { const k = await p((await tx("faces", "readonly")).getKey(fn)); return k !== undefined; },
      async getSrs(id) { return p((await tx("srs", "readonly")).get(id)); },
      async putSrs(state) { const s = await tx("srs", "readwrite"); return p(s.put(state)); },
      async allSrs() { return p((await tx("srs", "readonly")).getAll()) || []; },
    };
  })();

  // --- GitHub read (same token/repo the capture side uses) ------------------
  const ghRepo = () => (localStorage.getItem("ghRepo") || "ClemensGvL/card-captures-data").trim();
  const ghToken = () => (localStorage.getItem("ghToken") || "").trim();
  async function ghRaw(path, asBlob) {
    const t = ghToken();
    if (!t) throw new Error("No GitHub token set (Settings).");
    const r = await fetch(`https://api.github.com/repos/${ghRepo()}/contents/${path}`, {
      headers: { "Authorization": "Bearer " + t, "Accept": "application/vnd.github.raw" },
    });
    if (r.status !== 200) throw new Error("GitHub " + r.status + " for " + path);
    return asBlob ? await r.blob() : await r.text();
  }
  // Write a small JSON file to the repo (create or update). Used to flag a bad photo.
  async function ghPutJson(path, obj, message) {
    const t = ghToken();
    if (!t) throw new Error("No GitHub token set (Settings).");
    const url = `https://api.github.com/repos/${ghRepo()}/contents/${path}`;
    const hdr = { "Authorization": "Bearer " + t, "Accept": "application/vnd.github+json" };
    let sha = null;
    const g = await fetch(url, { headers: hdr });
    if (g.status === 200) sha = (await g.json()).sha;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
    const body = sha ? { message, content, sha } : { message, content };
    const r = await fetch(url, { method: "PUT", headers: Object.assign(hdr, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
    if (r.status !== 200 && r.status !== 201) throw new Error("GitHub " + r.status);
  }
  const initials = (name) => { const w = (name || "?").trim().split(/\s+/); return (((w[0] || "")[0] || "") + ((w[w.length - 1] || "")[0] || "")).toUpperCase(); };

  // --- SM-2 (transparent; FSRS can replace this one function later) ---------
  const today = () => new Date().toISOString().slice(0, 10);
  function addDays(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function schedule(prev, grade) {
    let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = prev || {};
    if (grade === "again") {
      ease = Math.max(1.3, ease - 0.2); reps = 0; interval = 0; lapses += 1;
    } else {
      const q = grade === "hard" ? 3 : grade === "good" ? 4 : 5;
      ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
      if (reps === 0) interval = grade === "easy" ? 2 : 1;
      else if (reps === 1) interval = grade === "hard" ? 3 : 6;
      else interval = Math.round(interval * (grade === "hard" ? 1.2 : ease) * (grade === "easy" ? 1.3 : 1));
      interval = Math.max(1, interval); reps += 1;
    }
    return { ease, interval, reps, lapses, due: addDays(today(), interval), last: today() };
  }

  // --- session state --------------------------------------------------------
  let nav = null;            // navigator (show) injected from app.js
  let roster = [];           // full roster (all 753; faced subset is reviewable)
  let queue = [];            // ids to drill this session
  let cur = null;            // current person

  const faced = () => roster.filter((p) => p.photo);

  async function dueIds() {
    const srs = {}; (await RDB.allSrs()).forEach((s) => (srs[s.id] = s));
    const t = today();
    const ppl = faced();
    const due = ppl.filter((p) => { const s = srs[p.id]; return !s || s.due <= t; });
    return (due.length ? due : ppl).map((p) => p.id);   // nothing due -> review all faced
  }

  // --- subsampling: filter the session by keywords -------------------------
  // Searches all the person's text. Comma = OR, space = AND:
  //   "IMF, World Bank" -> either;  "IMF debt" -> IMF and debt.
  const personText = (p) =>
    [p.name, p.org, p.title, p.met_where, p.event, p.tags, p.context_note]
      .filter(Boolean).join(" ").toLowerCase();
  function matchesQuery(text, query) {
    const groups = query.toLowerCase().split(",").map((g) => g.trim()).filter(Boolean);
    if (!groups.length) return true;
    return groups.some((g) => g.split(/\s+/).every((term) => text.includes(term)));
  }
  function filteredPeople() {
    const q = ($("rvFilter").value || "").trim();
    if (!q) return null;                       // null = no filter -> due-based session
    return roster.filter((p) => matchesQuery(personText(p), q));
  }
  const facedFirst = (list) => [...list.filter((p) => p.photo), ...list.filter((p) => !p.photo)];
  function updateFilterCount() {
    const f = filteredPeople();
    if (!f) { $("rvFilterCount").textContent = ""; return; }
    $("rvFilterCount").textContent = `${f.length} match · ${f.filter((p) => p.photo).length} with photo`;
  }

  function personById(id) { return roster.find((p) => p.id === id); }

  async function renderHome(msg) {
    const ppl = faced();
    const srs = {}; (await RDB.allSrs()).forEach((s) => (srs[s.id] = s));
    const t = today();
    const due = ppl.filter((p) => { const s = srs[p.id]; return !s || s.due <= t; }).length;
    $("rvStatus").innerHTML =
      `<b>${ppl.length}</b> people with a face · <b>${due}</b> due now` +
      (roster.length ? ` · ${roster.length} in roster` : "") +
      (msg ? `<br>${msg}` : "");
    $("rvHome").style.display = "block";
    $("rvCard").style.display = "none";
  }

  async function loadRosterIntoMemory() { roster = await RDB.roster(); }

  async function sync() {
    $("rvStatus").textContent = "Updating…";
    try {
      const text = await ghRaw("review/roster.json", false);
      const list = JSON.parse(text);
      await RDB.putRoster(list);
      roster = list;
      // Pull any faces we don't have cached yet.
      let pulled = 0;
      const want = [...new Set(list.filter((p) => p.photo).map((p) => p.photo))];
      for (const fn of want) {
        if (await RDB.hasFace(fn)) continue;
        try { await RDB.putFace(fn, await ghRaw("review/faces/" + fn, true)); pulled += 1; }
        catch (e) { /* a missing face shouldn't break the sync */ }
      }
      await renderHome(`Updated: ${list.length} people, ${pulled} new face(s) downloaded.`);
    } catch (e) {
      await renderHome("Update failed: " + e.message);
    }
  }

  async function showFace() {
    const blob = cur.photo ? await RDB.face(cur.photo) : null;
    const img = $("rvFace"), ini = $("rvInitials");
    if (blob) { img.src = URL.createObjectURL(blob); img.style.display = "block"; ini.style.display = "none"; }
    else { img.removeAttribute("src"); img.style.display = "none"; ini.textContent = initials(cur.name); ini.style.display = "flex"; }
    $("rvAnswer").style.display = "none";
    $("rvShow").style.display = "block";
    $("rvGrades").style.display = "none";
    $("rvWrong").style.display = cur.photo ? "block" : "none";
    $("rvProgress").textContent = `${queue.length} left this session`;
  }

  // Flag the current photo as unrepresentative; the laptop re-finds one next pass.
  async function rejectPhoto() {
    if (!cur) return;
    const safe = cur.id.replace(/[^a-z0-9._@-]/gi, "_");
    $("rvProgress").textContent = "Flagging photo…";
    try {
      await ghPutJson(`review/rejections/${safe}.json`,
        { id: cur.id, name: cur.name, rejected_file: cur.photo || "", at: today() },
        `reject photo: ${cur.name}`);
    } catch (e) {
      $("rvProgress").textContent = "Couldn't flag (" + e.message + ").";
      return;
    }
    cur.photo = null;                     // fall back to initials for this session
    $("rvProgress").textContent = "Flagged — a better photo will be fetched on next update.";
    setTimeout(() => next(), 800);
  }

  function reveal() {
    const sub = [cur.title, cur.org].filter(Boolean).join(" · ");
    $("rvName").textContent = cur.name || "(no name)";
    $("rvSub").textContent = sub;
    $("rvMet").textContent = cur.met_where ? ("Met: " + cur.met_where + (cur.met_when ? " (" + String(cur.met_when).slice(0, 10) + ")" : "")) : "";
    $("rvNote").textContent = cur.context_note || "";
    $("rvAnswer").style.display = "block";
    $("rvShow").style.display = "none";
    $("rvGrades").style.display = "flex";
  }

  async function next() {
    if (!queue.length) { await renderHome("Session done. Nice work."); return; }
    cur = personById(queue.shift());
    if (!cur) return next();
    await showFace();
  }

  async function grade(g) {
    const prev = await RDB.getSrs(cur.id);
    const state = schedule(prev, g);
    state.id = cur.id;
    await RDB.putSrs(state);
    if (g === "again") queue.push(cur.id);     // see it again before the session ends
    await next();
  }

  async function start() {
    if (!roster.length) await loadRosterIntoMemory();
    const f = filteredPeople();
    if (f) {                                   // subsampled session (faces first, then initials)
      if (!f.length) { await renderHome("No one matches that filter."); return; }
      queue = facedFirst(f).map((p) => p.id);
    } else {                                    // default: due faces
      if (!faced().length) { await renderHome("No faces yet. Tap “Update faces & roster”."); return; }
      queue = await dueIds();
    }
    $("rvHome").style.display = "none";
    $("rvCard").style.display = "block";
    await next();
  }

  return {
    async init(navigator) {
      nav = navigator;
      $("rvBack").onclick = () => nav("home");
      $("rvEnd").onclick = () => renderHome("");
      $("rvSync").onclick = () => sync();
      $("rvStart").onclick = () => start();
      $("rvShow").onclick = () => reveal();
      $("rvWrong").onclick = () => rejectPhoto();
      $("rvFilter").oninput = () => updateFilterCount();
      $("rvGrades").querySelectorAll("button").forEach((b) => (b.onclick = () => grade(b.dataset.g)));
    },
    async open() {
      await loadRosterIntoMemory();
      await renderHome(roster.length ? "" : "First time: tap “Update faces & roster”.");
      updateFilterCount();
    },
  };
})();
