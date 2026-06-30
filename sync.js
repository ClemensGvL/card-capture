// Drains the IndexedDB queue to the local sync agent over HTTPS.
// On a confirmed per-item merge, the item is removed from the queue.
const SYNC = (() => {
  function agentUrl() { return (localStorage.getItem("agentUrl") || "").replace(/\/+$/, ""); }

  function toPayload(rec) {
    return {
      id: rec.id,
      name: rec.name || null,
      last_name: rec.last_name || null,
      email: rec.email || null,
      phone: rec.phone || null,
      company: rec.company || null,
      title: rec.title || null,
      how_met: rec.how_met || null,
      date_met: rec.date_met || null,
      context_note: rec.context_note || null,
      event: rec.event || null,
      tags: rec.event || null,
      captured_at: rec.capturedAt || null,
      card_image_base64: rec.cardImageDataUrl || null,
    };
  }

  return {
    async health() {
      const base = agentUrl();
      if (!base) throw new Error("No agent URL set (Settings).");
      const r = await fetch(base + "/health", { method: "GET" });
      if (!r.ok) throw new Error("Agent returned " + r.status);
      return r.json();
    },
    async run() {
      const base = agentUrl();
      if (!base) throw new Error("No agent URL set (Settings).");
      const items = await DB.all();
      if (!items.length) return { synced: 0, remaining: 0 };
      const r = await fetch(base + "/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captures: items.map(toPayload) }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new Error("Sync failed (" + r.status + "): " + detail);
      }
      const data = await r.json();
      const ok = new Set();
      for (const res of (data.results || [])) {
        if (["merged", "updated", "duplicate"].includes(res.status)) ok.add(res.id);
      }
      for (const id of ok) await DB.remove(id);
      const remaining = await DB.count();
      return { synced: ok.size, remaining };
    },
  };
})();
