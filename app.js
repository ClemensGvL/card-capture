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

  // --- naive business-card parser ---------------------------------------------
  function parseCard(text) {
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const out = { email: "", phone: "", name: "", last: "", company: "", title: "" };
    const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const phoneRe = /(\+?\d[\d\s().-]{6,}\d)/;
    const titleRe = /(manager|director|engineer|officer|economist|founder|ceo|cto|cfo|analyst|advisor|consultant|head|lead|professor|partner|associate|president|chief|minister)/i;
    for (const l of lines) {
      if (!out.email) { const m = l.match(emailRe); if (m) out.email = m[0].toLowerCase(); }
      if (!out.phone) { const m = l.match(phoneRe); if (m && (m[0].replace(/\D/g, "").length >= 7)) out.phone = m[0].trim(); }
      if (!out.title && titleRe.test(l) && l.length < 60) out.title = l;
    }
    // Name guess: first short line with no digits/@ and looks like a person.
    const nameLine = lines.find((l) => !/[@\d]/.test(l) && l.split(/\s+/).length <= 4 && /^[A-Za-zÀ-ÿ.'-]/.test(l));
    if (nameLine) {
      const parts = nameLine.split(/\s+/);
      out.name = parts[0] || "";
      out.last = parts.slice(1).join(" ");
    }
    // Company guess: a line with Inc/LLP/GmbH/Ltd/Bank/Group, else the longest non-name line.
    const compRe = /(inc\.?|llp|llc|gmbh|ltd\.?|group|bank|university|capital|partners|corp\.?|company|fund|associates)/i;
    out.company = lines.find((l) => compRe.test(l) && l !== nameLine) || "";
    // Derive email from domain hint if email missing? No — never invent data.
    return out;
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
      $("ocrnote").textContent = "OCR unavailable offline (first load needs network once). Type the fields.";
      return;
    }
    $("ocrnote").textContent = "Reading card…";
    try {
      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath: "vendor/worker.min.js",
        corePath: "vendor/",
        langPath: "vendor/",
      });
      const { data } = await worker.recognize(dataUrl);
      await worker.terminate();
      fillForm(parseCard(data.text || ""));
      $("ocrnote").textContent = "Parsed — check & fix below.";
    } catch (e) {
      $("ocrnote").textContent = "OCR failed — type the fields. (" + e.message + ")";
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
  $("btnSettings").onclick = () => { $("agentUrl").value = localStorage.getItem("agentUrl") || ""; show("settings"); };
  $("btnBack").onclick = () => show("home");
  $("btnSaveSettings").onclick = () => {
    localStorage.setItem("agentUrl", $("agentUrl").value.trim());
    show("home");
  };
  $("btnTest").onclick = async () => {
    localStorage.setItem("agentUrl", $("agentUrl").value.trim());
    $("testResult").textContent = "Testing…";
    try {
      const h = await SYNC.health();
      $("testResult").textContent = "OK — agent reachable. Schema approved: " + h.schema_approved;
    } catch (e) {
      $("testResult").textContent = "Failed: " + e.message;
    }
  };

  refreshBadge();
})();
