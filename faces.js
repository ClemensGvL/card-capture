// Personal faces: pick a photo, pinch/drag a square crop onto the face, give it
// a name (first name is enough) and a context line, queue it. "Sync now" pushes
// it under faces/ in the private repo (sync.js); the laptop writes it to the
// "Faces" sheet, never to App Captures. No OCR and no email involved.
const FACES = (() => {
  const $ = (id) => document.getElementById(id);
  const OUT = 512;        // exported face edge (px)
  const SRC_MAX = 2048;   // working copy long side (px) — keeps pinch smooth
  const MAX_ZOOM = 6;     // max scale, as a multiple of "cover"

  // Same shape as app.js's uuid(); duplicated on purpose (no cross-file coupling).
  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      ("f" + Date.now() + Math.floor(Math.random() * 1e6));
  }

  let nav = null, onQueued = null;
  let src = null;                       // working canvas (#fcImg) once a photo is loaded
  let W = 0, H = 0;                     // working canvas size (source px)
  let scale = 1, minS = 1, maxS = 1;    // CSS px per source px
  let tx = 0, ty = 0;                   // translation in CSS px
  let cropDataUrl = null;               // exported 512×512 JPEG
  const pointers = new Map();           // active pointers for drag / pinch
  let lastDist = 0, lastMid = null;

  const frame = () => $("fcFrame");
  const V = () => frame().clientWidth;  // viewport edge (square)

  // --- decode ----------------------------------------------------------------
  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }
  function loadImage(url) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Could not read this image."));
      i.src = url;
    });
  }
  async function decode(file) {
    // createImageBitmap honours EXIF orientation; fall back to <img> otherwise.
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (e) { /* fall through */ }
    }
    return loadImage(await fileToDataUrl(file));
  }

  async function loadFile(file) {
    const bmp = await decode(file);
    const k = Math.min(1, SRC_MAX / Math.max(bmp.width, bmp.height));
    W = Math.max(1, Math.round(bmp.width * k));
    H = Math.max(1, Math.round(bmp.height * k));
    src = $("fcImg");
    src.width = W; src.height = H;       // resets the canvas
    src.getContext("2d").drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();
    fit();
  }

  // --- crop geometry -----------------------------------------------------------
  // "cover": the shorter image side fills the square; that is also the minimum
  // zoom, so the square never shows blank edges.
  function fit() {
    const v = V();
    minS = v / Math.min(W, H);
    maxS = minS * MAX_ZOOM;
    scale = minS;
    tx = (v - W * scale) / 2;
    ty = (v - H * scale) / 2;
    apply();
  }
  function clamp() {
    const v = V();
    scale = Math.min(maxS, Math.max(minS, scale));
    tx = Math.min(0, Math.max(v - W * scale, tx));
    ty = Math.min(0, Math.max(v - H * scale, ty));
  }
  function apply() {
    if (!src) return;
    clamp();
    src.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // Slider mirrors the zoom on a log scale between cover and MAX_ZOOM×cover.
    $("fcZoom").value = Math.round(1000 * Math.log(scale / minS) / Math.log(MAX_ZOOM));
  }
  // Zoom so the source point under viewport (px, py) stays put.
  function zoomAbout(px, py, s) {
    s = Math.min(maxS, Math.max(minS, s));
    tx = px - (px - tx) * (s / scale);
    ty = py - (py - ty) * (s / scale);
    scale = s;
    apply();
  }

  // --- gestures (Pointer Events; touch-action:none on the frame) --------------
  function onDown(e) {
    if (!src) return;
    try { frame().setPointerCapture(e.pointerId); } catch (err) { /* not capturable; drag still works inside the frame */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastDist = 0; lastMid = null;
    e.preventDefault();
  }
  function onMove(e) {
    if (!src || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {            // drag
      tx += e.clientX - prev.x;
      ty += e.clientY - prev.y;
      apply();
      return;
    }
    const [a, b] = [...pointers.values()];   // pinch: first two pointers
    const r = frame().getBoundingClientRect();
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    if (lastDist && lastMid) {
      tx += mid.x - lastMid.x;
      ty += mid.y - lastMid.y;
      zoomAbout(mid.x, mid.y, scale * (dist / lastDist));
    }
    lastDist = dist; lastMid = mid;
    e.preventDefault();
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    lastDist = 0; lastMid = null;
  }

  // --- export -------------------------------------------------------------------
  // Source-rect form of app.js's shrink(): the viewport square mapped back into
  // working-canvas coordinates, drawn into a 512×512 JPEG.
  function exportCrop() {
    const v = V();
    const c = document.createElement("canvas");
    c.width = OUT; c.height = OUT;
    c.getContext("2d").drawImage(src, -tx / scale, -ty / scale, v / scale, v / scale, 0, 0, OUT, OUT);
    return c.toDataURL("image/jpeg", 0.85);
  }

  // --- screens -------------------------------------------------------------------
  function showPanel(which) {
    $("fcCrop").style.display = which === "crop" ? "block" : "none";
    $("fcForm").style.display = which === "form" ? "block" : "none";
  }
  function reset() {
    src = null; cropDataUrl = null; W = H = 0;
    pointers.clear(); lastDist = 0; lastMid = null;
    const c = $("fcImg");
    c.width = 1; c.height = 1; c.style.transform = "";
    $("fcZoom").value = 0;
    $("fcFile").value = "";
    $("fc_name").value = ""; $("fc_context").value = "";
    $("fcPreview").removeAttribute("src");
    showPanel("crop");
  }
  function cancel() { reset(); nav("home"); }

  function useCrop() {
    if (!src) { $("fcFile").click(); return; }
    cropDataUrl = exportCrop();
    $("fcPreview").src = cropDataUrl;
    showPanel("form");
    $("fc_name").focus();
  }

  async function save() {
    const name = $("fc_name").value.trim();
    if (!name) { alert("Add a name — first name is enough."); return; }
    if (!cropDataUrl) { showPanel("crop"); return; }
    const rec = {
      id: uuid(),
      kind: "face",
      name,
      context_note: $("fc_context").value.trim(),
      capturedAt: new Date().toISOString(),
      faceImageDataUrl: cropDataUrl,
    };
    await DB.add(rec);
    reset();
    nav("home");
    if (onQueued) await onQueued("Face saved to queue. Sync when you have signal.");
  }

  return {
    init(navigator, queuedCallback) {
      nav = navigator; onQueued = queuedCallback;
      const f = frame();
      f.addEventListener("pointerdown", onDown);
      f.addEventListener("pointermove", onMove);
      f.addEventListener("pointerup", onUp);
      f.addEventListener("pointercancel", onUp);
      // Belt and braces for iOS Safari: never let the page scroll or zoom instead.
      f.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
      f.addEventListener("gesturestart", (e) => e.preventDefault());
      $("fcFile").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try { await loadFile(file); }
        catch (err) { alert("Couldn't open that photo: " + (err && err.message ? err.message : err)); reset(); }
      };
      $("fcZoom").oninput = () => {
        if (!src) return;
        const v = V();
        zoomAbout(v / 2, v / 2, minS * Math.pow(MAX_ZOOM, Number($("fcZoom").value) / 1000));
      };
      $("fcUse").onclick = () => useCrop();
      $("fcRetake").onclick = () => { $("fcFile").value = ""; $("fcFile").click(); };
      $("fcBack").onclick = () => showPanel("crop");
      $("fcSave").onclick = () => save();
      $("fcCancel1").onclick = cancel;
      $("fcCancel2").onclick = cancel;
    },
    open() {
      reset();
      $("fcFile").click();   // straight into the photo picker (camera or library)
    },
  };
})();
