// Pushes queued captures to a PRIVATE GitHub repo (the always-on relay).
// One capture = one new file under captures/ — creates never need a SHA, so
// pushes never conflict. The laptop merges these into Excel one-way, later.
// The GitHub token lives only on this phone (Settings), never in the app shell.
const SYNC = (() => {
  const API = "https://api.github.com";
  function repo() { return (localStorage.getItem("ghRepo") || "ClemensGvL/card-captures-data").trim(); }
  function token() { return (localStorage.getItem("ghToken") || "").trim(); }

  function ghHeaders() {
    const t = token();
    if (!t) throw new Error("No GitHub token set (Settings).");
    return { "Authorization": "Bearer " + t, "Accept": "application/vnd.github+json" };
  }

  // UTF-8 safe base64 for JSON payloads.
  function b64utf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  async function putFile(path, base64content, message) {
    const r = await fetch(`${API}/repos/${repo()}/contents/${path}`, {
      method: "PUT",
      headers: Object.assign(ghHeaders(), { "Content-Type": "application/json" }),
      body: JSON.stringify({ message, content: base64content }),
    });
    // 201 created. 422 = file already exists (already synced) -> treat as done.
    if (r.status === 201 || r.status === 422) return true;
    const detail = await r.text().catch(() => "");
    throw new Error(`GitHub ${r.status}: ${detail.slice(0, 140)}`);
  }

  function metaOf(rec) {
    return {
      id: rec.id, name: rec.name || "", last_name: rec.last_name || "",
      email: rec.email || "", phone: rec.phone || "", company: rec.company || "",
      title: rec.title || "", how_met: rec.how_met || "", date_met: rec.date_met || "",
      context_note: rec.context_note || "", event: rec.event || "",
      tags: rec.event || "", captured_at: rec.capturedAt || "",
      card_image: rec.cardImageDataUrl ? `captures/img/${rec.id}.jpg` : "",
    };
  }

  return {
    async health() {
      const r = await fetch(`${API}/repos/${repo()}`, { headers: ghHeaders() });
      if (r.status === 200) return { ok: true, repo: repo() };
      if (r.status === 401) throw new Error("Token rejected (401). Check the token.");
      if (r.status === 404) throw new Error("Repo not found / token lacks access: " + repo());
      throw new Error("GitHub returned " + r.status);
    },
    async run() {
      const items = await DB.all();
      if (!items.length) return { synced: 0, remaining: 0 };
      let synced = 0;
      for (const rec of items) {
        // Image first (so the JSON's reference is valid once present).
        if (rec.cardImageDataUrl) {
          const b64 = rec.cardImageDataUrl.includes(",")
            ? rec.cardImageDataUrl.split(",", 2)[1] : rec.cardImageDataUrl;
          await putFile(`captures/img/${rec.id}.jpg`, b64, `card image ${rec.id}`);
        }
        await putFile(`captures/${rec.capturedAt || ""}-${rec.id}.json`,
          b64utf8(JSON.stringify(metaOf(rec), null, 2)), `capture ${rec.id}`);
        await DB.remove(rec.id);
        synced++;
      }
      const remaining = await DB.count();
      return { synced, remaining };
    },
  };
})();
