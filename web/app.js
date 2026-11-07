// ======================= app.js : the user interface =======================
const $ = id => document.getElementById(id);
const store = {                                   // localStorage that never crashes the app
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

let manifest = [], byId = new Map(), packDir = "pack";
const poseCache = new Map();
const favs = new Set(store.get("bdsl_favs", []));
let history = store.get("bdsl_history", []);
let dark = store.get("bdsl_dark", window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
let mirror = store.get("bdsl_mirror", false);
let current = null;                               // sentence now on the main stage

// ---------- small helpers ----------
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600);
}
async function getPose(m) {
  if (poseCache.has(m.id)) return poseCache.get(m.id);
  const res = await fetch(`${packDir}/poses/${m.id}.bsl`);
  if (!res.ok) throw new Error("missing " + m.id);
  const pose = parsePose(await res.arrayBuffer());
  poseCache.set(m.id, pose);
  return pose;
}
function applyTheme() {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  main.draw(); practice.draw();
}

// ---------- animation player (one per canvas) ----------
class Player {
  constructor(canvas) {
    this.c = canvas; this.ctx = canvas.getContext("2d");
    this.pose = null; this.pos = 0; this.playing = false; this.speed = 1; this.loop = true; this.last = 0; this.onTick = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    requestAnimationFrame(t => this.tick(t));
  }
  resize() {
    const r = this.c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * d)); this.c.height = Math.max(1, Math.round(r.height * d));
    this.draw();
  }
  set(pose) { this.pose = pose; this.pos = 0; this.playing = true; this.draw(); }
  frame() { return this.pose ? Math.min(this.pose.frames - 1, Math.floor(this.pos)) : 0; }
  draw() {
    if (!this.pose) { this.ctx.clearRect(0, 0, this.c.width, this.c.height); return; }
    drawAvatar(this.ctx, this.pose, this.frame(), this.c.width, this.c.height, { dark, mirror });
  }
  tick(t) {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0; this.last = t;
    if (this.pose && this.playing && this.c.offsetParent !== null) {
      this.pos += dt * this.pose.fps * this.speed;
      if (this.pos >= this.pose.frames) {
        if (this.loop) this.pos %= this.pose.frames; else { this.pos = this.pose.frames - 1; this.playing = false; }
      }
      this.draw();
      if (this.onTick) this.onTick(this);
    }
    requestAnimationFrame(x => this.tick(x));
  }
}
const main = new Player($("stage"));
const practice = new Player($("stage2"));
const dragging = { v: false };

main.onTick = p => {
  if (!dragging.v) $("scrub").value = Math.round(p.pos / p.pose.frames * 1000);
  $("play").textContent = p.playing ? "Pause" : "Play";
};

// ---------- favourites + history ----------
function saveFavs() { store.set("bdsl_favs", [...favs]); }
function toggleFav(id) { favs.has(id) ? favs.delete(id) : favs.add(id); saveFavs(); }
function renderFavBtn() {
  const b = $("favBtn");
  if (!current) { b.hidden = true; return; }
  b.hidden = false; const on = favs.has(current.id);
  b.textContent = on ? "★" : "☆"; b.classList.toggle("on", on);
}
function pushHistory(m) {
  history = [m.id, ...history.filter(x => x !== m.id)].slice(0, 8);
  store.set("bdsl_history", history); renderRecent();
}
function renderRecent() {
  const box = $("recent"); box.innerHTML = "";
  const items = history.map(id => byId.get(id)).filter(Boolean);
  $("recentWrap").hidden = items.length === 0;
  items.forEach(m => {
    const b = document.createElement("button"); b.textContent = m.text;
    b.onclick = () => show(m, null); box.appendChild(b);
  });
}

// ---------- translate view ----------
function badge(score) {
  const b = $("badge");
  if (score === null) { b.hidden = true; return; }
  b.hidden = false; b.className = "badge";
  if (score >= 0.999) b.textContent = "Exact match";
  else if (score >= 0.6) b.textContent = "Close match " + Math.round(score * 100) + "%";
  else if (score >= 0.35) { b.textContent = "Weak match " + Math.round(score * 100) + "%"; b.classList.add("warn"); }
  else { b.textContent = "No close match"; b.classList.add("bad"); }
}
async function show(m, score) {
  try {
    const pose = await getPose(m);
    current = m; main.set(pose); main.speed = currentSpeed();
    $("empty").hidden = true;
    $("sentence").textContent = m.text;
    const g = $("gloss"); g.innerHTML = "";
    m.gloss.split(/\s+/).map(w => w.replace(/\/+/g, "")).filter(Boolean).forEach(w => {
      const s = document.createElement("span"); s.textContent = w; g.appendChild(s);
    });
    badge(score); renderFavBtn(); pushHistory(m);
    if (score !== null && score < 0.35) toast("No close match - showing the nearest sentence. Use Browse to find the right one.");
    $("list").innerHTML = "";
    switchView("translate");
  } catch (e) { toast("Could not load this sign."); }
}
function currentSpeed() { const on = document.querySelector("#speedSeg .on"); return on ? parseFloat(on.dataset.s) : 1; }

function suggest() {
  const q = $("q").value.trim(), list = $("list"); list.innerHTML = "";
  if (!q) return [];
  const ranked = rank(q, manifest, 4);
  ranked.forEach(({ m, score }) => {
    const li = document.createElement("li");
    const t = document.createElement("span"); t.textContent = m.text;
    const p = document.createElement("span"); p.className = "pct"; p.textContent = Math.round(score * 100) + "%";
    li.append(t, p); li.onclick = () => { $("q").value = m.text; show(m, score); };
    list.appendChild(li);
  });
  return ranked;
}

let ML_READY = false;           // set to true in Phase 4 once ml.js loads
const RECORDED_OK = 0.85;       // above this text similarity, play the real recording

async function runQuery() {
  const q = $("q").value.trim();
  if (!q) { randomSentence(); return; }
  const r = rank(q, manifest, 1)[0];
  if (r && (r.score >= RECORDED_OK || !ML_READY)) { show(r.m, r.score); return; }
  try {
    const gloss = textToGloss(q);                    // Phase 4 (ml.js)
    const pose = await generatePose(gloss);          // Phase 4 (ml.js)
    showGenerated(q, gloss, pose);
  } catch (e) {
    if (r) show(r.m, r.score); else toast("Could not sign this sentence.");
  }
}
function randomSentence() {
  const m = manifest[Math.floor(Math.random() * manifest.length)];
  $("q").value = m.text; show(m, null);
}
$("q").addEventListener("input", suggest);
$("q").addEventListener("keydown", e => { if (e.key === "Enter") runQuery(); });
$("go").onclick = runQuery;

// controls
$("play").onclick = () => { if (!main.pose) return; if (!main.playing && main.pos >= main.pose.frames - 1) main.pos = 0; main.playing = !main.playing; $("play").textContent = main.playing ? "Pause" : "Play"; };
$("replay").onclick = () => { if (!main.pose) return; main.pos = 0; main.playing = true; };
$("loopBtn").onclick = e => { main.loop = !main.loop; e.currentTarget.classList.toggle("on", main.loop); };
$("mirrorBtn").onclick = e => { mirror = !mirror; store.set("bdsl_mirror", mirror); e.currentTarget.classList.toggle("on", mirror); main.draw(); practice.draw(); };
$("mirrorBtn").classList.toggle("on", mirror);
$("speedSeg").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#speedSeg button").forEach(x => x.classList.toggle("on", x === b)); main.speed = parseFloat(b.dataset.s);
};
$("scrub").addEventListener("input", e => {
  if (!main.pose) return; dragging.v = true; main.playing = false;
  main.pos = Math.min(main.pose.frames - 1, e.target.value / 1000 * main.pose.frames); main.draw(); $("play").textContent = "Play";
});
$("scrub").addEventListener("change", () => dragging.v = false);
$("favBtn").onclick = () => { if (current) { toggleFav(current.id); renderFavBtn(); } };
$("themeBtn").onclick = () => { dark = !dark; store.set("bdsl_dark", dark); applyTheme(); };

// voice input (works in Chrome on Android; hidden where unsupported)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  $("mic").hidden = false;
  $("mic").onclick = () => {
    try {
      const r = new SR(); r.lang = "bn-BD"; r.interimResults = false;
      r.onresult = e => { $("q").value = e.results[0][0].transcript; suggest(); runQuery(); };
      r.onerror = () => toast("Could not hear you. Try again."); r.start(); toast("Listening…");
    } catch (e) { toast("Voice input is not available here."); }
  };
}

// ---------- browse view ----------
let browseLimit = 40, favOnly = false;
function renderBrowse() {
  const q = $("bq").value.trim(), list = $("blist"); list.innerHTML = "";
  let items = q ? rank(q, manifest, 400).filter(r => r.score > 0.15).map(r => r.m) : manifest;
  if (favOnly) items = items.filter(m => favs.has(m.id));
  items.slice(0, browseLimit).forEach(m => {
    const li = document.createElement("li");
    const t = document.createElement("span"); t.textContent = m.text;
    const s = document.createElement("button"); s.className = "star"; s.textContent = favs.has(m.id) ? "★" : "☆";
    s.onclick = e => { e.stopPropagation(); toggleFav(m.id); renderBrowse(); };
    li.append(t, s); li.onclick = () => { $("q").value = m.text; show(m, null); };
    list.appendChild(li);
  });
  if (!items.length) { const li = document.createElement("li"); li.textContent = favOnly ? "No favorites yet - tap ☆ on a sentence." : "No sentences found."; list.appendChild(li); }
  $("more").hidden = items.length <= browseLimit;
}
$("bq").addEventListener("input", () => { browseLimit = 40; renderBrowse(); });
$("more").onclick = () => { browseLimit += 40; renderBrowse(); };
$("favOnly").onclick = e => { favOnly = !favOnly; e.currentTarget.classList.toggle("on", favOnly); browseLimit = 40; renderBrowse(); };

// ---------- practice view ----------
const quiz = { score: 0, total: 0, streak: 0, answer: null, answered: false };
async function newRound() {
  if (manifest.length < 4) { $("feedback").textContent = "Practice needs at least 4 sentences."; return; }
  quiz.answered = false; $("next").hidden = true; $("feedback").textContent = "";
  const pool = [...manifest].sort(() => Math.random() - 0.5);
  const answer = pool[0], options = [answer];
  for (const m of pool.slice(1)) { if (options.length === 4) break; if (m.norm !== answer.norm) options.push(m); }
  options.sort(() => Math.random() - 0.5); quiz.answer = answer;
  const box = $("opts"); box.innerHTML = "";
  options.forEach(m => {
    const b = document.createElement("button"); b.textContent = m.text;
    b.onclick = () => answerQuiz(b, m); box.appendChild(b);
  });
  try { practice.set(await getPose(answer)); } catch (e) { toast("Could not load this sign."); }
}
function answerQuiz(btn, m) {
  if (quiz.answered) return; quiz.answered = true; quiz.total++;
  const ok = m.id === quiz.answer.id;
  if (ok) { quiz.score++; quiz.streak++; } else quiz.streak = 0;
  btn.classList.add(ok ? "right" : "wrong");
  [...$("opts").children].forEach(b => { if (b.textContent === quiz.answer.text) b.classList.add("right"); });
  $("feedback").textContent = ok ? "Correct! 🎉" : "Not quite. The sign was: " + quiz.answer.text;
  $("sc").textContent = quiz.score; $("tot").textContent = quiz.total; $("streak").textContent = quiz.streak;
  $("next").hidden = false;
}
$("next").onclick = newRound;
$("pReplay").onclick = () => { if (practice.pose) { practice.pos = 0; practice.playing = true; } };
$("pSpeed").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#pSpeed button").forEach(x => x.classList.toggle("on", x === b)); practice.speed = parseFloat(b.dataset.s);
};

// ---------- tabs ----------
let practiceStarted = false;
function switchView(v) {
  document.querySelectorAll(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  if (v === "browse") renderBrowse();
  if (v === "practice" && !practiceStarted && manifest.length) { practiceStarted = true; newRound(); }
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => switchView(b.dataset.v));

// ---------- start ----------
async function init() {
  applyTheme();
  try {
    manifest = await (await fetch("pack/manifest.json")).json();
  } catch (e) {
    packDir = "demo_pack";
    try { manifest = await (await fetch("demo_pack/manifest.json")).json(); $("banner").hidden = false; }
    catch (e2) { $("count").textContent = "No data found"; toast("pack/manifest.json was not found."); return; }
  }
  manifest.forEach(m => { m.tri = trigrams(m.norm); byId.set(m.id, m); });
  $("count").textContent = manifest.length + " sentences";
  renderRecent();
}
init();
// ---------- native (Capacitor) or browser ----------
const isNative = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
const Plugins = isNative ? Capacitor.Plugins : {};

function heard(text) { $("q").value = text; suggest(); runQuery(); }

if (isNative && Plugins.SpeechRecognition) {             // Android / iOS: native speech plugin
  $("mic").hidden = false;
  $("mic").onclick = async () => {
    try {
      await Plugins.SpeechRecognition.requestPermissions();
      const r = await Plugins.SpeechRecognition.start({ language: "bn-BD", maxResults: 1, popup: true, partialResults: false });
      if (r && r.matches && r.matches[0]) heard(r.matches[0]); else toast("Could not hear you. Try again.");
    } catch (e) { toast("Voice input is not available on this phone."); }
  };
} else {                                                  // browser: Web Speech API (Chrome)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    $("mic").hidden = false;
    $("mic").onclick = () => {
      try { const r = new SR(); r.lang = "bn-BD"; r.onresult = e => heard(e.results[0][0].transcript);
            r.onerror = () => toast("Could not hear you. Try again."); r.start(); toast("Listening…"); }
      catch (e) { toast("Voice input is not available here."); }
    };
  }
}

if (isNative && Plugins.App) {                            // Android back button
  Plugins.App.addListener("backButton", () => {
    if ($("view-translate").classList.contains("active")) Plugins.App.exitApp();
    else switchView("translate");
  });
}

if (!isNative && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
