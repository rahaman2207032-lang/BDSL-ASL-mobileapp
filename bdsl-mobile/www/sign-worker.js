// ======================= sign-worker.js : runs the word model off the main thread =======================
// The model needs ~0.5-1.5 s per sign on a phone; doing it here keeps the camera preview smooth.
importScripts("recognize.js?v=7");
let rec = null;
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      rec = await SignRecognizer.load(m.dir);
      postMessage({ type: "ready", words: rec.classes.length });
    } else if (m.type === "classify") {
      const frames = m.frames.map(f => new Float32Array(f));
      postMessage({ type: "result", id: m.id, top: rec.classify(frames, 3) });
    }
  } catch (err) {
    postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
