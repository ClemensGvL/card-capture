// Capture UI: camera -> offline OCR -> one-screen confirm -> IndexedDB queue.
(() => {
  const $ = (id) => document.getElementById(id);
  const screens = ["home", "confirm", "settings"];
  function show(name) {
    screens.forEach((s) => $(s).classList.toggle("active", s === name));
  }

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      ("c" + Date.now() + Math.floor(Math.random() * 1e6));
  }

  async function refreshBadge() {
    const n = await DB.count();
    const b = $("badge");
    b.textContent = n + " to sync";
    b.classList.toggle("zero", n === 0);
  }

  // --- business-card parser ---------------------------------------------------
  // Org / title keyword sets, reused for name-exclusion and field-picking.
  const ORG_RE = /(inc\.?|llp|llc|gmbh|ltd\.?|group|bank|university|capital|partners|corp\.?|company|fund|associates|department|ministry|affairs|treasury|division|office|institute|agency|council|bureau|holdings|ventures|foundation|trust)/i;
  const TITLE_RE = /(manager|director|engineer|officer|economist|founder|ceo|cto|cfo|analyst|advisor|adviser|consultant|head|lead|professor|partner|associate|president|chief|minister|secretary|counsel|specialist|coordinator|administrator|researcher|scientist|attorney|vice)/i;

  // Pull text lines WITH their pixel height from Tesseract's geometry, so we can
  // tell the name (biggest text) from the org/subtitle. Falls back to plain text.
  function linesWithHeight(data) {
    const out = [];
    if (data && data.blocks && data.blocks.length) {
      data.blocks.forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => {
        const t = (l.text || "").trim();
        const bb = l.bbox || {};
        if (t) out.push({ text: t, h: (bb.y1 - bb.y0) || 0 });
      })));
    }
    if (!out.length && data && data.text) {
      data.text.split(/\n/).forEach((t) => { t = t.trim(); if (t) out.push({ text: t, h: 0 }); });
    }
    return out;
  }

  function looksLikeName(t) {
    if (/[@\d]/.test(t)) return false;
    const words = t.split(/\s+/);
    if (words.length < 1 || words.length > 4) return false;
    if (ORG_RE.test(t) || TITLE_RE.test(t)) return false;
    return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’-]*(\s+[A-Za-zÀ-ÿ().'’-]+){0,3}$/.test(t);
  }

  function parseCardData(data) {
    const lines = linesWithHeight(data);
    const fullText = lines.map((l) => l.text).join("\n");
    const out = { email: "", phone: "", name: "", last: "", company: "", title: "" };

    // Email: try as-is, then with whitespace stripped (OCR sprinkles spaces).
    const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    let m = fullText.match(emailRe) || fullText.replace(/\s+/g, "").match(emailRe);
    if (m) out.email = m[0].toLowerCase();

    // Phone: longest digit run that looks like a real number.
    const phones = fullText.match(/\+?[\d][\d\s().\-/]{6,}\d/g) || [];
    const best = phones.map((p) => p.trim()).filter((p) => p.replace(/\D/g, "").length >= 7)
      .sort((a, b) => b.replace(/\D/g, "").length - a.replace(/\D/g, "").length)[0];
    if (best) out.phone = best;

    // Name: the biggest name-ish line (font size beats reading order).
    const nameCand = lines.filter((l) => looksLikeName(l.text)).sort((a, b) => b.h - a.h)[0];
    if (nameCand) {
      let parts = nameCand.text.split(/\s+/);
      if (/^(dr|mr|mrs|ms|mx|prof|sir|dame|rev)\.?$/i.test(parts[0])) parts = parts.slice(1);
      out.name = parts[0] || "";
      out.last = parts.slice(1).join(" ");
    }
    // Title: first line with a role keyword (not the name).
    const titleLine = lines.find((l) => l.text !== (nameCand && nameCand.text) && TITLE_RE.test(l.text) && l.text.length < 60);
    if (titleLine) out.title = titleLine.text;
    // Company: biggest org-ish line (not the name/title).
    const compCand = lines.filter((l) => ORG_RE.test(l.text) && l.text !== (nameCand && nameCand.text) && l.text !== (titleLine && titleLine.text))
      .sort((a, b) => b.h - a.h)[0];
    if (compCand) out.company = compCand.text;
    return out;  // never invent data — empty stays empty
  }

  let currentImageDataUrl = null;

  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }

  // Downscale a captured photo so the queued image stays small.
  function shrink(dataUrl, maxW = 1280) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => res(dataUrl);
      img.src = dataUrl;
    });
  }

  function fillForm(p) {
    $("f_name").value = p.name || "";
    $("f_last").value = p.last || "";
    $("f_email").value = p.email || "";
    $("f_phone").value = p.phone || "";
    $("f_title").value = p.title || "";
    $("f_company").value = p.company || "";
  }

  function clearForm() {
    ["f_name","f_last","f_email","f_phone","f_title","f_company","f_howmet","f_context","f_event"].forEach((id) => ($(id).value = ""));
    $("preview").style.display = "none";
    $("ocrnote").textContent = "";
    currentImageDataUrl = null;
  }

  async function runOCR(dataUrl) {
    if (window.__noOCR || !window.Tesseract) {
      $("ocrnote").textContent = "OCR engine didn't load. Reopen the app once online, then retry. You can still type the fields.";
      return;
    }
    // Absolute URLs: Tesseract resolves these inside its Web Worker (whose own
    // base is /vendor/), so relative paths would double to /vendor/vendor/.
    const base = new URL("vendor/", location.href).href;
    $("ocrnote").textContent = "Reading card… 0%";
    try {
      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath: base + "worker.min.js",
        corePath: base,
        langPath: base,
        logger: (m) => {
          if (m.status === "recognizing text") {
            $("ocrnote").textContent = "Reading card… " + Math.round((m.progress || 0) * 100) + "%";
          }
        },
      });
      const { data } = await worker.recognize(dataUrl, {}, { blocks: true });
      await worker.terminate();
      const text = (data && data.text) || "";
      if (!text.trim()) {
        $("ocrnote").textContent = "Couldn't read this image — try a sharper, straight-on photo, or type the fields.";
        return;
      }
      fillForm(parseCardData(data));
      $("ocrnote").textContent = "Parsed — check & fix the fields below.";
    } catch (e) {
      $("ocrnote").textContent = "OCR error: " + (e && e.message ? e.message : e) + " — type the fields.";
    }
  }

  // --- events -----------------------------------------------------------------
  $("btnCard").onclick = () => { clearForm(); $("file").click(); };
  $("btnNoCard").onclick = () => { clearForm(); show("confirm"); $("f_email").focus(); };

  $("file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    show("confirm");
    const raw = await fileToDataUrl(file);
    currentImageDataUrl = await shrink(raw);
    $("preview").src = currentImageDataUrl;
    $("preview").style.display = "block";
    runOCR(currentImageDataUrl);
  };

  $("btnConfirm").onclick = async () => {
    const email = $("f_email").value.trim().toLowerCase();
    const name = $("f_name").value.trim();
    if (!email && !name) { alert("Add at least a name or an email."); return; }
    const rec = {
      id: uuid(),
      name, last_name: $("f_last").value.trim(),
      email,
      phone: $("f_phone").value.trim(),
      title: $("f_title").value.trim(),
      company: $("f_company").value.trim(),
      how_met: $("f_howmet").value.trim(),
      date_met: new Date().toISOString().slice(0, 10),
      context_note: $("f_context").value.trim(),
      event: $("f_event").value.trim(),
      capturedAt: new Date().toISOString(),
      cardImageDataUrl: currentImageDataUrl,
    };
    await DB.add(rec);
    await refreshBadge();
    clearForm();
    show("home");
    $("syncStatus").textContent = "Saved to queue. Sync when you're near your laptop.";
  };

  $("btnCancel").onclick = () => { clearForm(); show("home"); };

  $("btnSync").onclick = async () => {
    $("syncStatus").textContent = "Syncing…";
    try {
      const r = await SYNC.run();
      $("syncStatus").textContent = `Synced ${r.synced}. ${r.remaining} still queued.`;
      await refreshBadge();
    } catch (e) {
      $("syncStatus").textContent = "Sync error: " + e.message;
    }
  };

  // settings
  $("btnSettings").onclick = () => {
    $("ghRepo").value = localStorage.getItem("ghRepo") || "ClemensGvL/card-captures-data";
    $("ghToken").value = localStorage.getItem("ghToken") || "";
    show("settings");
  };
  $("btnBack").onclick = () => show("home");
  function saveSettings() {
    localStorage.setItem("ghRepo", $("ghRepo").value.trim());
    localStorage.setItem("ghToken", $("ghToken").value.trim());
  }
  $("btnSaveSettings").onclick = () => { saveSettings(); show("home"); };
  $("btnTest").onclick = async () => {
    saveSettings();
    $("testResult").textContent = "Testing…";
    try {
      const h = await SYNC.health();
      $("testResult").textContent = "OK — connected to " + h.repo;
    } catch (e) {
      $("testResult").textContent = "Failed: " + e.message;
    }
  };

  refreshBadge();
})();
