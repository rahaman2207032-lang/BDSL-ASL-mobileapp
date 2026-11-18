// ======================= camera.js : front camera -> MediaPipe landmarks -> words (Bangla OR English) =======================
// বাংলা  : PoseLandmarker + HandLandmarker -> 75 points -> BdSLW60 word model in sign-worker.js (on the phone).
// English: HolisticLandmarker -> 543 points (face, hands, pose; Kaggle ASL layout) -> asl_model.tflite on your PC
//          (english-server/server.py, via EnglishEngine in lang.js).
// Same pipeline as bdsl_word_model/sign_to_word_webcam.py:
//   PoseLandmarker (lite) + HandLandmarker -> 75 points per frame -> word model (in sign-worker.js).
// HOLD mode: tap Record, sign ONE word, tap Stop.   AUTO mode: sign a word, hold still, it splits by pauses.
// Needs from app.js: $, toast, rank, manifest, show, switchView, runQuery.
(function () {
  "use strict";
  const CONF_MIN = 0.35;            // below this the word is shown with "?" and not added to the sentence
  // The model learned from LANDSCAPE video; a phone held upright gives a PORTRAIT picture. MediaPipe's x is a
  // fraction of the picture WIDTH, so in a tall picture every pose looks squeezed sideways. We stretch x (and z,
  // which MediaPipe measures on the same scale as x) back to these proportions. 4/3 = a normal PC webcam, which
  // already recognises well. Set to 16/9 if your training videos were 16:9 widescreen.
  const TARGET_ASPECT = 4 / 3;
  const MIN_FRAMES = 6;             // HOLD: shorter recordings are ignored (same as the webcam script)
  const MAX_SECONDS = 6;            // HOLD: stop automatically after this long
  const MOTION_ON = 0.012, STILL_FRAMES = 8, MIN_SIGN_FRAMES = 8;   // AUTO: same values as the webcam script
  const POSE_N = 33, LH_N = 21, N_PTS = 75;

  // camera styles are injected here so the tab works even if style.css was not updated or is cached.
  // (Without them the empty-camera placeholder covers the whole page and blocks every click.)
  if (!document.getElementById("cam-css")) {
    const st = document.createElement("style"); st.id = "cam-css";
    st.textContent = `.cam-card { position: relative; width: 100%; aspect-ratio: 3 / 4; max-height: 52vh; margin: 8px auto; border-radius: 24px;
  overflow: hidden; background: #111; box-shadow: var(--shadow); }
.cam-card video, .cam-card canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  transform: scaleX(-1); pointer-events: none; }          /* mirrored, like looking in a mirror */
.cam-card .stage-empty { color: #ddd; }
.cam-status { position: absolute; left: 12px; top: 12px; padding: 4px 10px; border-radius: 999px;
  background: rgba(0, 0, 0, .55); color: #fff; font-size: .85rem; }
.rec-btn { background: var(--bad); color: #fff; font-weight: 600; min-width: 110px; }
.rec-btn.rec { background: #263238; }
button:disabled { opacity: .45; }
.result-row { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
.sign-word { font-size: 2rem; font-weight: 700; }
.sign-word.unsure { color: var(--warn); }
.controls.left { justify-content: flex-start; }
.primary-chip { background: var(--primary); color: #fff; border-color: var(--primary); }
.hint { margin: 10px 0 0; font-size: .85rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#signSentence { margin: 0 0 8px; font-size: 1.15rem; font-weight: 600; min-height: 1.4em; }
#signSentence.muted { font-weight: 400; color: var(--muted); }`;
    document.head.appendChild(st);
  }

  // if index.html is missing part of the camera screen, say so instead of silently doing nothing
  const NEED = ["view-sign", "cam", "camDots", "camStatus", "camEmpty", "camStart", "recBtn", "modeSeg", "signWord", "signConf",
                "signAlts", "signReady", "signSentence", "sentUndo", "sentClear", "sentPlay", "signHint"];
  const missingIds = NEED.filter(id => !document.getElementById(id));
  if (missingIds.length) {
    console.error("[camera] index.html is missing:", missingIds); window.__cameraReady = true;
    const v = document.getElementById("view-sign");
    if (v) v.insertAdjacentHTML("afterbegin", '<p style="padding:10px;border-radius:12px;background:#fdecea;color:#8a1c1c">' +
      "Camera tab is incomplete (missing: " + missingIds.join(", ") + "). Run: node tools\\add_camera_tab.js</p>");
    return;
  }

  let mp = null, pose = null, hands = null, holistic = null, stream = null, running = false;
  const isEn = () => window.SignLang && SignLang.get() === "en";
  let pipeLang = null;                                 // language the loaded landmark models belong to
  let buf543 = [];
  let worker = null, workerReady = false, busy = false, jobId = 0;
  let mode = "hold", recording = false, recStart = 0, buf = [], still = 0, prev = null;
  let lastTs = 0, lastVideoTime = -1, usedDelegate = "", fpsT = [];
  const sentence = [];
  const video = $("cam"), dots = $("camDots"), dctx = dots.getContext("2d");

  const status = t => { $("camStatus").textContent = t; $("camStatus").hidden = !t; };

  // ---------- word model (background worker) ----------
  function startWorker() {
    if (worker) return;
    try { worker = new Worker("sign-worker.js?v=7"); }
    catch (e) { $("signReady").textContent = "· word model could not start (open the page via http://localhost:8000, not as a file)"; return; }
    worker.onerror = e => { $("signReady").textContent = "· word model failed: " + (e.message || "sign-worker.js / recognize.js missing?"); };
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === "ready") { workerReady = true; $("signReady").textContent = "· model knows " + m.words + " words"; }
      else if (m.type === "result") showResult(m.top);
      else if (m.type === "error") {
        busy = false;
        if (!workerReady) $("signReady").textContent = "· word model failed to load: " + m.message + " (check www/models/sign)";
        else toast("Recognition failed: " + m.message);
      }
    };
    worker.postMessage({ type: "load", dir: "models/sign" });
  }

  // Drop the empty start/end of a recording (no hand visible yet / any more), keeping KEEP frames on each side.
  // Training clips are cut around the sign, so long idle stretches only confuse the model.
  const KEEP = 4;
  function trimRange(frames) {                    // [first, last] frame worth keeping
    const hasHand = f => { for (let i = POSE_N * 3; i < N_PTS * 3; i++) if (f[i] !== 0) return true; return false; };
    let a = frames.findIndex(hasHand);
    if (a < 0) return [0, frames.length - 1];        // no hands at all: leave it (model will say "not sure")
    let b = frames.length - 1; while (b > a && !hasHand(frames[b])) b--;
    a = Math.max(0, a - KEEP); b = Math.min(frames.length - 1, b + KEEP);
    return b - a + 1 >= MIN_FRAMES ? [a, b] : [0, frames.length - 1];
  }
  function trimIdle(frames) { const [a, b] = trimRange(frames); return frames.slice(a, b + 1); }

  let waiting = null;                               // newest sign recorded while the previous one was being recognised
  function runWaiting() { if (waiting && !busy) { const w = waiting; waiting = null; classify(w[0], w[1]); } }
  const anyHand = frames => frames.some(f => { for (let i = POSE_N * 3; i < N_PTS * 3; i++) if (f[i] !== 0) return true; return false; });

  function classify(frames, frames543) {
    if (frames543 && isEn()) {
      if (!anyHand(frames)) { $("signWord").textContent = "—"; $("signConf").textContent = "No hands were seen - keep both hands inside the picture"; return; }
      if (busy) { waiting = [frames, frames543]; $("signConf").textContent = "Next sign is waiting…"; return; }
      return classifyEnglish(frames, frames543);
    }
    if (!workerReady) { toast("The word model is still loading. Try again in a moment."); return; }
    if (busy) return;
    frames = trimIdle(frames);
    busy = true; $("signWord").textContent = "…"; $("signConf").textContent = "Recognizing";
    const copies = frames.map(f => f.slice().buffer);
    worker.postMessage({ type: "classify", id: ++jobId, frames: copies }, copies);
  }

  async function classifyEnglish(frames, frames543) {
    if (busy) return;
    const [a, b] = trimRange(frames);
    busy = true; $("signWord").textContent = "…"; $("signConf").textContent = "Recognizing…";
    try { showResult(await EnglishEngine.signToWord(frames543.slice(a, b + 1))); runWaiting(); }
    catch (e) { busy = false; $("signWord").textContent = "—"; $("signConf").textContent = ""; toast("ASL recognition: " + e.message); }
    runWaiting();
  }

  async function classifyFrames(shots) {
    if (busy) { toast("Still recognising the previous sign - try again in a moment."); return; }
    busy = true; $("signWord").textContent = "…"; $("signConf").textContent = `Recognizing (${shots.length} frames)…`;
    try { showResult(await EnglishEngine.framesToWord(shots)); }
    catch (e) {
      busy = false; $("signWord").textContent = "—";
      $("signConf").textContent = /hands/i.test(e.message) ? e.message : "";
      if (!/hands/i.test(e.message)) toast("ASL recognition: " + e.message);
    }
  }

  function showResult(top) {
    busy = false;
    if (!top || !top.length) { $("signWord").textContent = "—"; $("signConf").textContent = "No answer"; return; }
    document.dispatchEvent(new CustomEvent("sign-result", { detail: top }));
    const best = top[0], ok = best.p >= CONF_MIN;
    $("signWord").textContent = ok ? best.word : best.word + " ?";
    $("signWord").classList.toggle("unsure", !ok);
    $("signConf").textContent = Math.round(best.p * 100) + "%" + (ok ? "" : " - not sure: tap + Add or a guess below, or sign again");
    $("signAlts").innerHTML = "";
    let replaced = ok;                               // true once this result's word is in the sentence
    if (!ok) {                                       // not sure: let the user add the top word themselves
      const add = document.createElement("button"); add.className = "chip primary-chip";
      add.textContent = "+ Add " + best.word;
      add.onclick = () => {
        if (replaced) sentence.pop();
        sentence.push(best.word); replaced = true; renderSentence();
        $("signWord").textContent = best.word; $("signWord").classList.remove("unsure");
      };
      $("signAlts").appendChild(add);
    }
    top.slice(1).forEach(t => {                      // tap a runner-up to use it instead
      const b = document.createElement("button"); b.className = "chip";
      b.textContent = `${t.word} ${Math.round(t.p * 100)}%`;
      b.onclick = () => {
        if (replaced) sentence.pop();
        sentence.push(t.word); replaced = true; renderSentence();
        $("signWord").textContent = t.word; $("signWord").classList.remove("unsure");
      };
      $("signAlts").appendChild(b);
    });
    if (ok) { sentence.push(best.word); renderSentence(); }
  }

  function renderSentence() {
    const text = sentence.join(" ");
    $("signSentence").textContent = text || "Signed words will appear here";
    $("signSentence").classList.toggle("muted", !text);
    $("sentPlay").disabled = !text; $("sentUndo").disabled = !text; $("sentClear").disabled = !text;
    const hint = $("signHint"); hint.hidden = true;
    if (text && !isEn() && typeof manifest !== "undefined" && manifest.length) {
      const r = rank(text, manifest, 1)[0];
      if (r && r.score >= 0.35) {
        hint.hidden = false; hint.innerHTML = "";
        const s = document.createElement("span"); s.textContent = "Closest dataset sentence: ";
        const b = document.createElement("button"); b.className = "chip"; b.textContent = r.m.text;
        b.onclick = () => show(r.m, r.score);
        hint.append(s, b);
      }
    }
  }

  // ---------- MediaPipe ----------
  async function loadLandmarkers() {
    const want = isEn() ? "en" : "bn";
    if (pipeLang !== want) { pose = hands = holistic = null; pipeLang = want; }
    if (want === "en" ? (holistic || (pose && hands)) : (pose && hands)) return;
    try { mp = await import("./mediapipe/vision_bundle.js"); }
    catch (e) { throw new Error("www/mediapipe/vision_bundle.js is missing or broken - run: node tools/copy_mediapipe.js  (" + e.message + ")"); }
    let vision;
    try { vision = await withTimeout(mp.FilesetResolver.forVisionTasks("mediapipe/wasm"), 60000, "MediaPipe engine (www/mediapipe/wasm) did not load"); }
    catch (e) { throw new Error("MediaPipe engine files in www/mediapipe/wasm did not load - run: node tools/copy_mediapipe.js  (" + e.message + ")"); }
    const make = async (Cls, path, opts) => {
      let last;
      for (const delegate of ["GPU", "CPU"]) {            // GPU is faster; some phones only manage CPU
        try {
          status(`Camera on. Loading ${path.split("/").pop()} (${delegate})…`);
          usedDelegate = delegate;
          return await withTimeout(Cls.createFromOptions(vision, { baseOptions: { modelAssetPath: path, delegate }, runningMode: "VIDEO", ...opts }),
                                   delegate === "GPU" ? 20000 : 60000, `${path} (${delegate})`);
        } catch (e) { last = e; console.warn("[camera]", delegate, "failed for", path, e); }
      }
      throw new Error("Could not load " + path + " - is the file in www/models? (" + (last && last.message || last) + ")");
    };
    if (want === "en") {
      if (mp.HolisticLandmarker) {                   // same landmarks as the Kaggle ASL data (face + hands + pose)
        try {
          holistic = await make(mp.HolisticLandmarker, "models/holistic_landmarker.task",
            { minFaceDetectionConfidence: 0.5, minPoseDetectionConfidence: 0.5, minHandLandmarksConfidence: 0.5 });   // = the settings the ASL training data used
          return;
        } catch (e) { console.warn("[camera] holistic failed, using pose + hands", e); }
      } else console.warn("[camera] this MediaPipe has no HolisticLandmarker - ASL accuracy is lower (no face points). Update: npm i @mediapipe/tasks-vision@latest && node tools/copy_mediapipe.js");
    }
    pose = await make(mp.PoseLandmarker, "models/pose_landmarker_lite.task",
      { numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    hands = await make(mp.HandLandmarker, "models/hand_landmarker.task",
      { numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
  }

  // 75 points exactly like res_to_75() in the notebook: pose 0-32, "Left" hand 33-53, "Right" hand 54-74, missing = 0
  function toFrame(pr, hr) {
    const f = new Float32Array(N_PTS * 3);
    const pl = pr.landmarks && pr.landmarks[0];
    if (pl) for (let j = 0; j < POSE_N && j < pl.length; j++) { f[j * 3] = pl[j].x; f[j * 3 + 1] = pl[j].y; f[j * 3 + 2] = pl[j].z; }
    const hl = hr.landmarks || [], hd = hr.handedness || hr.handednesses || [];
    hl.forEach((lms, i) => {
      const cat = hd[i] && hd[i][0];
      const label = cat ? (cat.categoryName || cat.displayName) : "Right";
      const off = label === "Left" ? POSE_N : POSE_N + LH_N;
      for (let j = 0; j < LH_N && j < lms.length; j++) { const p = (off + j) * 3; f[p] = lms[j].x; f[p + 1] = lms[j].y; f[p + 2] = lms[j].z; }
    });
    return f;
  }

  // English: Kaggle ASL layout, 543 points: face 0-467 | left hand 468-488 | pose 489-521 | right hand 522-542, NaN = missing
  const first = a => (a && a.length ? (Array.isArray(a[0]) ? a[0] : a) : null);
  function put(f, off, lms, n) { if (!lms) return; for (let j = 0; j < n && j < lms.length; j++) { const p = (off + j) * 3; f[p] = lms[j].x; f[p + 1] = lms[j].y; f[p + 2] = lms[j].z; } }
  function holisticFrames(r) {
    const f543 = new Float32Array(1629).fill(NaN), f75 = new Float32Array(N_PTS * 3);
    const face = first(r.faceLandmarks), pl = first(r.poseLandmarks), lh = first(r.leftHandLandmarks), rh = first(r.rightHandLandmarks);
    put(f543, 0, face, 468); put(f543, 468, lh, 21); put(f543, 489, pl, 33); put(f543, 522, rh, 21);
    put(f75, 0, pl, POSE_N); put(f75, POSE_N, rh, LH_N); put(f75, POSE_N + LH_N, lh, LH_N);   // f75 only drives the dots / motion
    return [f75, f543];
  }
  function poseHandTo543(pr, hr) {                 // fallback without Holistic: no face; MediaPipe's "Left" label = person's right hand
    const f543 = new Float32Array(1629).fill(NaN);
    put(f543, 489, pr.landmarks && pr.landmarks[0], 33);
    const hl = hr.landmarks || [], hd = hr.handedness || hr.handednesses || [];
    hl.forEach((lms, i) => { const c = hd[i] && hd[i][0], lab = c ? (c.categoryName || c.displayName) : "Right"; put(f543, lab === "Left" ? 522 : 468, lms, 21); });
    return f543;
  }

  function fixAspect(f, vw, vh) {                  // portrait phone picture -> same geometry as a landscape webcam
    if (!vw || !vh) return f;
    const k = (vw / vh) / TARGET_ASPECT;            // 1 on a 4:3 webcam (no change), 0.5625 on a 480x640 phone picture
    if (Math.abs(k - 1) < 1e-3) return f;
    const g = new Float32Array(f.length);
    for (let i = 0; i < f.length; i += 3) {
      if (f[i] === 0 && f[i + 1] === 0 && f[i + 2] === 0) continue;   // keep "not detected" as 0
      g[i] = f[i] * k; g[i + 1] = f[i + 1]; g[i + 2] = f[i + 2] * k;
    }
    return g;
  }

  function handMotion(a, b) {                      // mean movement of the hand points between two frames
    let s = 0, n = 0;
    for (let p = POSE_N; p < N_PTS; p++) {
      const i = p * 3;
      const za = a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 0, zb = b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0;
      if (za || zb) continue;
      s += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]); n++;
    }
    return n ? s / n : 0;
  }

  function drawDots(f) {                           // light feedback: are my hands being seen?
    const d = window.devicePixelRatio || 1, w = Math.round(dots.clientWidth * d), h = Math.round(dots.clientHeight * d);
    if (dots.width !== w || dots.height !== h) { dots.width = w; dots.height = h; }
    dctx.clearRect(0, 0, w, h);
    const vw = video.videoWidth || 1, vh = video.videoHeight || 1, k = Math.max(w / vw, h / vh);  // object-fit: cover
    const ox = (w - vw * k) / 2, oy = (h - vh * k) / 2;
    for (let p = 11; p < N_PTS; p++) {
      if (p > 16 && p < POSE_N) continue;          // shoulders, elbows, wrists + both hands
      const i = p * 3; if (f[i] === 0 && f[i + 1] === 0) continue;
      dctx.beginPath(); dctx.arc(ox + f[i] * vw * k, oy + f[i + 1] * vh * k, (p < POSE_N ? 5 : 3) * d, 0, 7);
      dctx.fillStyle = p < POSE_N ? "rgba(255,255,255,.8)" : p < POSE_N + LH_N ? "#ff6b8b" : "#7bd3ff"; dctx.fill();
    }
  }

  function fps() {                                 // tracking speed over the last second (phones are slower than a PC)
    const now = performance.now(); fpsT.push(now); while (fpsT.length && now - fpsT[0] > 1000) fpsT.shift();
    return fpsT.length;
  }

  // A hand appearing or disappearing also counts as movement (on phones tracking flickers, and the old
  // "both frames must have the hand" rule then saw a moving hand as standing still and threw the sign away).
  const handOn = (f, off) => { for (let i = off * 3; i < (off + LH_N) * 3; i++) if (f[i] !== 0) return true; return false; };
  function enMotion(a, b) {
    for (const off of [POSE_N, POSE_N + LH_N]) if (handOn(a, off) !== handOn(b, off)) return 1;
    return handMotion(a, b);
  }
  const EN_STILL_MS = 700, EN_MIN_SIGN_MS = 300, EN_MAX_SIGN_MS = 6000, EN_PREROLL = 4;
  let enSign = null, enPre = [];
  function onFrameEnglishAuto(f, f543) {
    const now = performance.now(), moving = prev && enMotion(prev, f) > MOTION_ON;
    if (!enSign) {
      enPre.push([f, f543]); if (enPre.length > EN_PREROLL) enPre.shift();
      if (moving && anyHand([f])) { enSign = { start: now, last: now, fr: enPre.slice() }; enPre = []; status("Signing…"); }
      return;
    }
    if (moving) { enSign.fr.push([f, f543]); enSign.last = now; }
    const done = now - enSign.last > EN_STILL_MS, tooLong = now - enSign.start > EN_MAX_SIGN_MS;
    if (!done && !tooLong) return;
    const keep = enSign.fr;
    const long = enSign.last - enSign.start >= EN_MIN_SIGN_MS;
    enSign = null;
    if (long) classify(keep.map(x => x[0]), keep.map(x => x[1]));
    status("Sign a word, then hold still");
  }

  function onFrame(f, f543) {
    if (mode !== "hold" && f543 && isEn()) { onFrameEnglishAuto(f, f543); prev = f; return; }
    if (mode === "hold") {
      if (recording) {
        buf.push(f); if (f543) buf543.push(f543); status(`● REC  ${buf.length} frames · ${fps()} fps`);
        if (performance.now() - recStart > MAX_SECONDS * 1000) stopRecording();
      }
    } else {
      const moving = prev && handMotion(prev, f) > MOTION_ON;
      if (moving) { buf.push(f); if (f543) buf543.push(f543); still = 0; status("Signing…"); }
      else {
        still++;
        if (still === STILL_FRAMES && buf.length >= MIN_SIGN_FRAMES) { classify(buf, f543 ? buf543 : null); buf = []; buf543 = []; }
        if (still > STILL_FRAMES) { buf = []; buf543 = []; status("Sign a word, then hold still"); }
      }
    }
    prev = f;
  }

  // English + Hold + an engine that can track (Hugging Face Space / server.py with mediapipe 0.10.14):
  // record small camera pictures instead of tracking on the device, and let the engine find the points with
  // the same classic MediaPipe Holistic as sign_live.py. Faster on phones too (no tracking while recording).
  const SNAP_W = 480, SNAP_FPS = 24, SNAP_Q = 0.8;
  let snaps = [], snapT = 0, snapCanvas = null;
  const serverHold = () => mode === "hold" && isEn() && window.EnglishEngine && EnglishEngine.serverTracking;
  function snap() {
    const now = performance.now();
    if (now - snapT < 1000 / SNAP_FPS - 4 || video.currentTime === lastVideoTime) return;   // only new camera frames
    snapT = now; lastVideoTime = video.currentTime;
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return;
    const k = Math.min(1, SNAP_W / Math.max(vw, vh));
    snapCanvas = snapCanvas || document.createElement("canvas");
    snapCanvas.width = Math.round(vw * k); snapCanvas.height = Math.round(vh * k);
    snapCanvas.getContext("2d").drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);   // not mirrored, like sign_live.py
    snaps.push(snapCanvas.toDataURL("image/jpeg", SNAP_Q));
    status(`● REC  ${snaps.length} frames · ${fps()} fps`);
    if (now - recStart > MAX_SECONDS * 1000) stopRecording();
  }

  function loop() {
    if (!running) return;
    if (recording && serverHold()) { if (video.readyState >= 2) snap(); requestAnimationFrame(loop); return; }
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const ts = lastTs = Math.max(lastTs + 1, Math.round(performance.now()));   // must always increase
      try {
        if (holistic) {
          const [f, f543] = holisticFrames(holistic.detectForVideo(video, ts));
          drawDots(f); onFrame(f, f543);
        } else {
          const pr = pose.detectForVideo(video, ts), hr = hands.detectForVideo(video, ts), f = toFrame(pr, hr);
          drawDots(f); onFrame(fixAspect(f, video.videoWidth, video.videoHeight), pipeLang === "en" ? poseHandTo543(pr, hr) : null);
        }
      } catch (e) { console.warn(e); }
    }
    requestAnimationFrame(loop);
  }

  // ---------- camera on / off ----------
  // Order matters: ask for the camera FIRST (permission prompt + live preview right away),
  // THEN load MediaPipe (10+ MB, can take 10-30 s the first time on a phone) with a visible message.
  let starting = false;
  async function startCamera() {
    if (running || starting) return;
    starting = true; showError("");
    try {
      if (location.protocol === "file:")
        throw new Error("The page was opened as a file. Open it through the server instead: http://localhost:8000");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
        throw new Error("This page is not allowed to use the camera. Use http://localhost:8000 on your PC, or the installed app on the phone (not http://192.168...).");
      startWorker();
      status("Asking for camera permission…");
      stream = await withTimeout(navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false }),
        30000, "The camera did not start (no answer to the permission request)");
      video.srcObject = stream; await video.play();
      $("camEmpty").hidden = true; $("camStart").textContent = "Stop camera";
      status("Camera on. Loading hand tracking… (first time can take up to 30 s)");
      await loadLandmarkers();
      if (!stream) { starting = false; return; }         // user pressed Stop while models were loading
      running = true; $("recBtn").disabled = false;
      status((mode === "hold" ? "Tap Record, sign one word, tap Stop" : "Sign a word, then hold still")
             + (usedDelegate === "CPU" ? "  (slow mode: this phone could not use its GPU for tracking)" : ""));
      loop();
    } catch (e) {
      stopCamera();
      const msg = e && e.name === "NotAllowedError"
        ? "Camera permission was denied. Allow it in the browser's address bar (PC) or in Settings > Apps > BdSL Sign Player > Permissions (phone). In the app, AndroidManifest.xml must have the CAMERA permission line."
        : e && e.name === "NotFoundError" ? "No camera was found on this device."
        : "Could not start the camera: " + (e && e.message || e);
      showError(msg); console.error("[camera]", e);
    }
    starting = false;
  }

  function withTimeout(promise, ms, what) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ` (waited ${ms / 1000} s)`)), ms))]);
  }

  function showError(msg) {                        // a message that stays on screen (toasts vanish too fast)
    let el = document.getElementById("camError");
    if (!el) {
      el = document.createElement("p"); el.id = "camError";
      el.style.cssText = "margin:8px 0;padding:10px 12px;border-radius:12px;background:#fdecea;color:#8a1c1c;font-size:.9rem;";
      document.querySelector("#view-sign .cam-card").after(el);
    }
    el.textContent = msg; el.hidden = !msg;
  }

  function stopCamera() {
    running = false; recording = false; buf = []; buf543 = []; prev = null; still = 0; enSign = null; enPre = []; waiting = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    $("camStart").textContent = "Start camera"; $("recBtn").disabled = true; $("camEmpty").hidden = false;
    setRecUI(); status(""); dctx.clearRect(0, 0, dots.width, dots.height);
  }

  function setRecUI() {
    const b = $("recBtn"); b.textContent = recording ? "■ Stop" : "● Record"; b.classList.toggle("rec", recording);
  }
  function startRecording() { buf = []; buf543 = []; snaps = []; snapT = 0; recording = true; recStart = performance.now(); setRecUI(); }
  function stopRecording() {
    recording = false; setRecUI();
    if (snaps.length) {                              // English, tracked on the engine (like sign_live.py)
      const shots = snaps; snaps = [];
      if (shots.length < MIN_FRAMES) toast("Too short - keep recording through the whole sign.");
      else classifyFrames(shots);
      buf = []; buf543 = []; status("Tap Record, sign one word, tap Stop"); return;
    }
    if (buf.length >= MIN_FRAMES) classify(buf, pipeLang === "en" ? buf543 : null); else toast("Too short - keep recording through the whole sign.");
    buf = []; buf543 = []; status("Tap Record, sign one word, tap Stop");
  }

  // ---------- buttons ----------
  $("camStart").onclick = () => (running || stream) ? stopCamera() : startCamera();
  $("recBtn").onclick = () => { if (!running || mode !== "hold") return; recording ? stopRecording() : startRecording(); };
  $("modeSeg").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.m; recording = false; buf = []; still = 0; enSign = null; enPre = []; setRecUI();
    document.querySelectorAll("#modeSeg button").forEach(x => x.classList.toggle("on", x === b));
    $("recBtn").hidden = mode !== "hold";
    if (running) status(mode === "hold" ? "Tap Record, sign one word, tap Stop" : "Sign a word, then hold still");
  };
  $("sentUndo").onclick = () => { sentence.pop(); renderSentence(); };
  $("sentClear").onclick = () => { sentence.length = 0; renderSentence(); };
  $("sentPlay").onclick = () => {                  // two-way: show the signed words back as signing
    const text = sentence.join(" "); if (!text) return;
    stopCamera();
    if (isEn() && window.SignLang && SignLang.goEnglish) return SignLang.goEnglish(text);
    $("q").value = text; switchView("translate"); runQuery();
  };

  // turn the camera off whenever the user leaves this tab (saves battery, frees the camera)
  new MutationObserver(() => { if (!$("view-sign").classList.contains("active") && running) stopCamera(); })
    .observe($("view-sign"), { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", () => { if (document.hidden && running) stopCamera(); });

  // switching language: different models and a different word list
  function readyText() {
    $("signReady").textContent = isEn() ? "· ASL model (250 words)" : workerReady ? $("signReady").dataset.bn || "· model ready" : "· loading model…";
  }
  let langSeen = null;
  document.addEventListener("lang-change", e => {         // sent by lang.js (also once at start-up)
    const first = langSeen === null; langSeen = e.detail; if (first) { readyText(); return; }
    if (running || stream) stopCamera();
    sentence.length = 0; renderSentence(); $("signWord").textContent = "—"; $("signConf").textContent = ""; $("signAlts").innerHTML = "";
    readyText();
  });
  new MutationObserver(() => { if (!isEn() && /knows/.test($("signReady").textContent)) $("signReady").dataset.bn = $("signReady").textContent; })
    .observe($("signReady"), { childList: true });

  renderSentence();
  startWorker();                                   // load the word model early (small, in the background)
  window.__cameraReady = true;                     // tells the check in index.html that camera.js started
})();
