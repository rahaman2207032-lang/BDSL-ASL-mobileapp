// ======================= sign-engine.js : sign recognition for ANY <video> (used by the Call screen) =======================
// Same pipeline as camera.js (same MediaPipe models, same 75 points, portrait fix, idle trimming, same word model
// in sign-worker.js). Usage:
//   await SignEngine.init(msg => ...)        load MediaPipe + word model (once)
//   SignEngine.attach(videoElement)          start reading landmarks from that video
//   SignEngine.startRecording()              user starts signing one word
//   const top = await SignEngine.stopRecording()   -> [{id, word, p}, ...] best first, or null if too short
//   SignEngine.detach()                      stop reading (camera stays as it is)
// English (SignLang.get() === "en"): HolisticLandmarker -> 543 points -> asl_model.tflite on your PC (EnglishEngine).
(function () {
  "use strict";
  const POSE_N = 33, LH_N = 21, N_PTS = 75, TARGET_ASPECT = 4 / 3, MIN_FRAMES = 6, KEEP = 4, MAX_FRAMES = 240;
  let mp = null, pose = null, hands = null, holistic = null, worker = null, ready = false, loading = null, readyLang = null;
  let video = null, running = false, lastTs = 0, lastTime = -1, recording = false, buf = [], buf543 = [];
  const langNow = () => (window.SignLang && SignLang.get() === "en" ? "en" : "bn");
  const jobs = new Map(); let jobId = 0;

  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);

  async function init(onStatus = () => {}) {
    if (ready && readyLang === langNow()) return;
    if (loading) return loading;
    ready = false; pose = hands = holistic = null;
    loading = (async () => {
      const want = langNow();
      if (want === "en") {
        onStatus("Connecting to the English engine…");
        await EnglishEngine.health();            // throws a clear message when server.py is not reachable
      } else if (!worker) {
      onStatus("Loading word model…");
      worker = new Worker("sign-worker.js?v=7");
      await new Promise((res, rej) => {
        worker.onmessage = e => {
          const m = e.data;
          if (m.type === "ready") res();
          else if (m.type === "result" && jobs.has(m.id)) { jobs.get(m.id).res(m.top); jobs.delete(m.id); }
          else if (m.type === "error") {
            if (jobs.has(m.id)) { jobs.get(m.id).rej(new Error(m.message)); jobs.delete(m.id); } else rej(new Error(m.message));
          }
        };
        worker.onerror = e => rej(new Error(e.message || "sign-worker.js failed"));
        worker.postMessage({ type: "load", dir: "models/sign" });
      });
      }
      onStatus("Loading hand tracking… (first time up to 30 s)");
      mp = await import("./mediapipe/vision_bundle.js");
      const vision = await withTimeout(mp.FilesetResolver.forVisionTasks("mediapipe/wasm"), 60000, "MediaPipe engine did not load");
      const make = async (Cls, path, opts) => {
        let last;
        for (const delegate of ["GPU", "CPU"]) {
          try { return await withTimeout(Cls.createFromOptions(vision, { baseOptions: { modelAssetPath: path, delegate }, runningMode: "VIDEO", ...opts }), delegate === "GPU" ? 20000 : 60000, path); }
          catch (e) { last = e; }
        }
        throw last;
      };
      if (want === "en" && mp.HolisticLandmarker) {
        try { holistic = await make(mp.HolisticLandmarker, "models/holistic_landmarker.task", { minFaceDetectionConfidence: 0.5, minPoseDetectionConfidence: 0.5, minHandLandmarksConfidence: 0.5 }); }
        catch (e) { console.warn("[sign-engine] holistic failed, using pose + hands", e); }
      }
      if (!holistic) {
      pose = await make(mp.PoseLandmarker, "models/pose_landmarker_lite.task",
        { numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      hands = await make(mp.HandLandmarker, "models/hand_landmarker.task",
        { numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      }
      ready = true; readyLang = want; onStatus("");
    })();
    try { await loading; } finally { loading = null; }
  }

  function toFrame(pr, hr) {                      // pose 0-32, "Left" hand 33-53, "Right" hand 54-74, missing = 0
    const f = new Float32Array(N_PTS * 3);
    const pl = pr.landmarks && pr.landmarks[0];
    if (pl) for (let j = 0; j < POSE_N && j < pl.length; j++) { f[j * 3] = pl[j].x; f[j * 3 + 1] = pl[j].y; f[j * 3 + 2] = pl[j].z; }
    const hl = hr.landmarks || [], hd = hr.handedness || hr.handednesses || [];
    hl.forEach((lms, i) => {
      const cat = hd[i] && hd[i][0];
      const off = (cat ? (cat.categoryName || cat.displayName) : "Right") === "Left" ? POSE_N : POSE_N + LH_N;
      for (let j = 0; j < LH_N && j < lms.length; j++) { const p = (off + j) * 3; f[p] = lms[j].x; f[p + 1] = lms[j].y; f[p + 2] = lms[j].z; }
    });
    return f;
  }

  function fixAspect(f, vw, vh) {                 // portrait phone picture -> landscape-webcam geometry
    if (!vw || !vh) return f;
    const k = (vw / vh) / TARGET_ASPECT;
    if (Math.abs(k - 1) < 1e-3) return f;
    const g = new Float32Array(f.length);
    for (let i = 0; i < f.length; i += 3) {
      if (f[i] === 0 && f[i + 1] === 0 && f[i + 2] === 0) continue;
      g[i] = f[i] * k; g[i + 1] = f[i + 1]; g[i + 2] = f[i + 2] * k;
    }
    return g;
  }

  function trimIdle(frames) {                     // drop empty start/end (no hand visible), keep KEEP frames each side
    const hasHand = f => { for (let i = POSE_N * 3; i < N_PTS * 3; i++) if (f[i] !== 0) return true; return false; };
    let a = frames.findIndex(hasHand);
    if (a < 0) return frames;
    let b = frames.length - 1; while (b > a && !hasHand(frames[b])) b--;
    a = Math.max(0, a - KEEP); b = Math.min(frames.length - 1, b + KEEP);
    const out = frames.slice(a, b + 1);
    return out.length >= MIN_FRAMES ? out : frames;
  }

  // English: 543 points in the Kaggle ASL layout (face | left hand | pose | right hand), NaN = missing
  const first = a => (a && a.length ? (Array.isArray(a[0]) ? a[0] : a) : null);
  function put(f, off, lms, n) { if (!lms) return; for (let j = 0; j < n && j < lms.length; j++) { const p = (off + j) * 3; f[p] = lms[j].x; f[p + 1] = lms[j].y; f[p + 2] = lms[j].z; } }
  function holisticFrames(r) {
    const f543 = new Float32Array(1629).fill(NaN), f75 = new Float32Array(N_PTS * 3);
    const pl = first(r.poseLandmarks), lh = first(r.leftHandLandmarks), rh = first(r.rightHandLandmarks);
    put(f543, 0, first(r.faceLandmarks), 468); put(f543, 468, lh, 21); put(f543, 489, pl, 33); put(f543, 522, rh, 21);
    put(f75, 0, pl, POSE_N); put(f75, POSE_N, rh, LH_N); put(f75, POSE_N + LH_N, lh, LH_N);
    return [f75, f543];
  }
  function poseHandTo543(pr, hr) {
    const f543 = new Float32Array(1629).fill(NaN);
    put(f543, 489, pr.landmarks && pr.landmarks[0], 33);
    const hl = hr.landmarks || [], hd = hr.handedness || hr.handednesses || [];
    hl.forEach((lms, i) => { const c = hd[i] && hd[i][0], lab = c ? (c.categoryName || c.displayName) : "Right"; put(f543, lab === "Left" ? 522 : 468, lms, 21); });
    return f543;
  }

  function loop() {
    if (!running) return;
    // only run the (heavy) hand + pose models while the user is actually recording a sign;
    // between signs the phone's CPU is left free for the video call and the avatar
    if (recording && video && video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      const ts = lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
      try {
        if (buf.length < MAX_FRAMES) {
          if (holistic) { const [f, f543] = holisticFrames(holistic.detectForVideo(video, ts)); buf.push(f); buf543.push(f543); }
          else {
            const pr = pose.detectForVideo(video, ts), hr = hands.detectForVideo(video, ts);
            buf.push(fixAspect(toFrame(pr, hr), video.videoWidth, video.videoHeight));
            if (readyLang === "en") buf543.push(poseHandTo543(pr, hr));
          }
        }
      } catch (e) { console.warn("[sign-engine]", e); }
    }
    requestAnimationFrame(loop);
  }

  function attach(v) { video = v; if (!running && ready) { running = true; loop(); } }
  function detach() { running = false; recording = false; buf = []; buf543 = []; video = null; }
  function startRecording() { buf = []; buf543 = []; recording = true; }
  function isRecording() { return recording; }
  async function stopRecording() {
    recording = false;
    if (readyLang === "en") {
      const all = buf, f543 = buf543; buf = []; buf543 = [];
      const frames = trimIdle(all); if (frames.length < MIN_FRAMES) return null;
      const a = all.indexOf(frames[0]);
      return EnglishEngine.signToWord(f543.slice(a, a + frames.length));
    }
    const frames = trimIdle(buf); buf = [];
    if (frames.length < MIN_FRAMES) return null;
    const id = ++jobId, copies = frames.map(f => f.slice().buffer);
    const p = new Promise((res, rej) => jobs.set(id, { res, rej }));
    worker.postMessage({ type: "classify", id, frames: copies }, copies);
    return p;
  }

  window.SignEngine = { init, attach, detach, startRecording, stopRecording, isRecording, get ready() { return ready && readyLang === langNow(); } };
})();
