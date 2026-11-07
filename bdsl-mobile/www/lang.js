// ======================= lang.js : Bangla (BdSL) <-> English (ASL) in ONE app =======================
// Load after app.js, camera.js, call.js and ui-pro.js.
//   বাংলা   : everything works exactly as before (text->sign = dataset retrieval, sign->text = BdSLW60 GRU, on the phone).
//   English : text->sign = your Motion-S GENERATIVE model, sign->text = your ASL tflite model (250 words).
//             Both run in english-server/server.py on your PC; the phone talks to it over the same Wi-Fi.
// Public:  SignLang.get() / set("bn"|"en") / on(fn)      EnglishEngine.textToPose(text) / signToWord(frames543) / health()
(function () {
  "use strict";
  const $id = id => document.getElementById(id);
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const say = m => (typeof toast === "function" ? toast(m) : console.log(m));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ------------------------------------------------------------------ language state
  let lang = ls.get("bdsl_lang", "bn") === "en" ? "en" : "bn";
  const listeners = [];
  const SignLang = {
    get: () => lang,
    set(v) {
      v = v === "en" ? "en" : "bn"; if (v === lang) return;
      lang = v; ls.set("bdsl_lang", v); apply(); listeners.forEach(fn => { try { fn(v); } catch (e) { console.warn(e); } });
      document.dispatchEvent(new CustomEvent("lang-change", { detail: v }));
    },
    on(fn) { listeners.push(fn); },
    speechCode: () => (lang === "en" ? "en-US" : "bn-BD"),
    label: v => ((v || lang) === "en" ? "English · ASL" : "বাংলা · BdSL"),
  };
  window.SignLang = SignLang;

  // ------------------------------------------------------------------ English engine (your PC)
  const IN_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  // Your Hugging Face Space address, e.g. "https://yourname-bdsl-english.hf.space".
  // When set, every phone uses it automatically (no PC, any Wi-Fi or mobile data).
  const HOSTED_ENGINE = "https://huggingface.co/spaces/Anne562/bdsl-english";
  const DEFAULT_ADDR = HOSTED_ENGINE || (!IN_APP && /^(localhost|127\.)/.test(location.hostname) ? "localhost:8765" : "");
  const poseCache = new Map();
  const EnglishEngine = {
    addr: () => ls.get("bdsl_en_server", "") || DEFAULT_ADDR,
    setAddr: a => ls.set("bdsl_en_server", String(a || "").trim().replace(/\/+$/, "")),
    url(path) {
      const a = this.addr(); if (!a) throw new Error("Set the English engine address first (English → Engine)");
      return (/^https?:\/\//.test(a) ? a : "http://" + a) + path;
    },
    // "https://huggingface.co/spaces/User/bdsl-english" -> "https://user-bdsl-english.hf.space"
    base() {
      let a = this.addr();
      const m = a.match(/huggingface\.co\/spaces\/([^\/?#]+)\/([^\/?#]+)/i);
      if (m) a = "https://" + (m[1] + "-" + m[2]).toLowerCase().replace(/[^a-z0-9-]/g, "-") + ".hf.space";
      return a.replace(/\/+$/, "");
    },
    hosted() { return /\.hf\.space/i.test(this.base()) || /huggingface\.co\/spaces/i.test(this.addr()); },
    async _gradio(name, args, ms) {                 // Hugging Face Space (Gradio API: POST, then read the result stream)
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms), base = this.base();
      try {
        const r = await fetch(`${base}/gradio_api/call/${name}`, { method: "POST", headers: { "Content-Type": "application/json" },
                                                                  body: JSON.stringify({ data: args }), signal: ctl.signal });
        if (!r.ok) throw new Error(r.status === 404 ? "the Space is not running yet (open it on huggingface.co)" : "HTTP " + r.status);
        const { event_id } = await r.json();
        const txt = await (await fetch(`${base}/gradio_api/call/${name}/${event_id}`, { signal: ctl.signal })).text();
        const m = txt.match(/event:\s*complete\s*\ndata:\s*(.*)/);
        if (!m) throw new Error("the Space returned an error" + (/event:\s*error/.test(txt) ? " (see its Logs)" : ""));
        const j = JSON.parse(JSON.parse(m[1])[0]);
        if (j.error) throw new Error(j.error);
        return j;
      } catch (e) {
        if (e.name === "AbortError") throw new Error("the English engine did not answer in time (the Space may be waking up - try again in a minute)");
        if (e instanceof TypeError) throw new Error("cannot reach the English engine at " + base);
        throw e;
      } finally { clearTimeout(t); }
    },
    async _fetch(path, opts = {}, ms = 8000) {
      if (this.hosted()) {
        if (path === "/health") return this._gradio("health", [], ms);
        if (path === "/api/en/text2sign") return this._gradio("text2sign", [JSON.parse(opts.body).text], ms);
        if (path === "/api/en/sign2word") {
          const u8 = new Uint8Array(opts.body); let bin = "";
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
          return this._gradio("sign2word", [btoa(bin), Number(opts.headers["X-Frames"])], ms);
        }
      }
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
      try {
        const r = await fetch(this.url(path), { ...opts, signal: ctl.signal });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        return j;
      } catch (e) {
        if (e.name === "AbortError") throw new Error("the English engine did not answer in time");
        if (e instanceof TypeError) throw new Error("cannot reach the English engine at " + this.addr() + " (is server.py running? same Wi-Fi?)");
        throw e;
      } finally { clearTimeout(t); }
    },
    health() { return this._fetch("/health", {}, this.hosted() ? 30000 : 15000); },
    async textToPose(text) {
      const key = String(text).trim().toLowerCase();
      if (poseCache.has(key)) return poseCache.get(key);
      const j = await this._fetch("/api/en/text2sign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }, this.hosted() ? 180000 : 120000);
      const bin = atob(j.pose), buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const out = { pose: parsePose(buf.buffer), gloss: j.gloss, text: j.text || text, ms: j.ms };
      poseCache.set(key, out); if (poseCache.size > 60) poseCache.delete(poseCache.keys().next().value);
      return out;
    },
    async signToWord(frames) {                      // frames: array of Float32Array(543*3), NaN = missing
      const T = frames.length, body = new Float32Array(T * 1629);
      frames.forEach((f, i) => body.set(f, i * 1629));
      const j = await this._fetch("/api/en/sign2word", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Frames": String(T) }, body: body.buffer }, 30000);
      return j.top || [];
    },
  };
  window.EnglishEngine = EnglishEngine;

  // ------------------------------------------------------------------ styles
  const css = document.createElement("style");
  css.textContent = `
  body.lang-en .bn-only, body:not(.lang-en) .en-only { display: none !important; }
  #enQ, #enBq, #enWq { flex: 1; min-width: 0; height: 52px; border-radius: var(--r-md, 16px); border: 1px solid var(--line); box-shadow: var(--shadow); padding: 0 14px 0 46px;
    font-size: 1rem; color: var(--text); background: var(--card) no-repeat 15px 50% / 20px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a8fae' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E"); }
  #enQ:focus, #enBq:focus, #enWq:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 18%, transparent); }
  #enMic { width: 52px; height: 52px; border-radius: var(--r-md, 16px); background: var(--card); border: 1px solid var(--line); box-shadow: var(--shadow); display: grid; place-items: center; color: var(--text); }
  #enGo { height: 52px; border-radius: var(--r-md, 16px); padding: 0 20px; }
  .lang-seg { display: flex; padding: 3px; gap: 2px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); margin-right: 8px; }
  .lang-seg button { min-height: 32px; height: 32px; padding: 0 10px; border-radius: 9px; font-size: .78rem; font-weight: 700; color: var(--muted); background: transparent; box-shadow: none; }
  .lang-seg button.on { background: var(--primary); color: #fff; }
  .en-engine { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin: 0 0 10px; border-radius: 14px; background: var(--card);
    border: 1px solid var(--line); font-size: .84rem; color: var(--muted); }
  .en-engine .dot { width: 10px; height: 10px; border-radius: 50%; background: #9aa0b8; flex: none; }
  .en-engine.ok .dot { background: #22c55e; } .en-engine.bad .dot { background: #e5484d; }
  .en-engine span { flex: 1; min-width: 0; }
  .en-engine button { height: 32px; min-height: 32px; padding: 0 12px; border-radius: 10px; font-size: .8rem; }
  .en-gen { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: var(--muted); font-size: .92rem; background: color-mix(in srgb, var(--card) 55%, transparent); backdrop-filter: blur(2px); }
  .en-gen i { display: block; width: 34px; height: 34px; margin: 0 auto 10px; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--primary); animation: enSpin .8s linear infinite; }
  @keyframes enSpin { to { transform: rotate(360deg); } }
  .en-meta { display: block; margin-top: 8px; color: var(--muted); font-size: .78rem; }
  .en-words { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin: 8px 0 16px; }
  .en-words button { height: 46px; min-height: 46px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); color: var(--text); font-weight: 600; font-size: .9rem; box-shadow: none; position: relative; }
  .en-words button.done::after { content: "✓"; position: absolute; top: 3px; right: 7px; font-size: .7rem; color: var(--ok); }
  .en-words button.cur { background: var(--primary); color: #fff; border-color: var(--primary); }
  .en-learn-card { border-radius: 20px; padding: 14px 16px; margin: 12px 0; background: var(--card); border: 1px solid var(--line); box-shadow: var(--shadow); }
  .en-learn-card h4 { margin: 0 0 4px; font-size: 1.4rem; } .en-learn-card p { margin: 0 0 10px; color: var(--muted); font-size: .86rem; }
  .en-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .en-target { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; padding: 10px 14px; border-radius: 14px; background: var(--soft); color: var(--soft-ink); font-weight: 600; }
  .en-target b { font-size: 1.2rem; } .en-target span { flex: 1; } .en-target button { height: 30px; min-height: 30px; padding: 0 10px; border-radius: 9px; font-size: .78rem; }
  .en-modal { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: rgba(10,10,25,.45); padding: 16px; }
  .en-modal[hidden] { display: none; }
  .en-modal > div { width: min(420px, 100%); background: var(--card); color: var(--text); border-radius: 22px; padding: 18px; box-shadow: var(--shadow-lg); }
  .en-modal h3 { margin: 0 0 4px; font-size: 1.1rem; text-transform: none; letter-spacing: 0; color: var(--text); }
  .en-modal p { margin: 0 0 12px; color: var(--muted); font-size: .86rem; line-height: 1.5; }
  .en-modal input { width: 100%; height: 48px; border-radius: 14px; border: 1px solid var(--line); padding: 0 14px; font-size: 1rem; background: var(--bg); color: var(--text); }
  .en-modal pre { white-space: pre-wrap; font-size: .8rem; background: var(--bg); border-radius: 12px; padding: 10px; margin: 10px 0; min-height: 3em; }
  .en-quiz-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
  .en-quiz-opts button { height: 48px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); color: var(--text); font-weight: 600; box-shadow: none; }
  .en-quiz-opts button.right { background: var(--ok); color: #fff; } .en-quiz-opts button.wrong { background: var(--bad); color: #fff; }`;
  document.head.appendChild(css);

  // ------------------------------------------------------------------ header switch + engine dialog
  const top = document.querySelector(".top"), theme = $id("themeBtn");
  const seg = document.createElement("div"); seg.className = "lang-seg"; seg.setAttribute("role", "tablist");
  seg.innerHTML = '<button data-l="bn">বাংলা</button><button data-l="en">English</button>';
  seg.onclick = e => { const b = e.target.closest("button"); if (b) SignLang.set(b.dataset.l); };
  if (top && theme) top.insertBefore(seg, theme);

  const modal = document.createElement("div"); modal.className = "en-modal"; modal.hidden = true;
  modal.innerHTML = `<div><h3>English engine</h3>
    <p>English signs are made by your generative model and recognised by your ASL model, which run in <b>english-server/server.py</b> on your PC.
    Start it, then type the address it prints (the phone must be on the same Wi-Fi).</p>
    <input id="enAddr" placeholder="192.168.0.105:8765" inputmode="url" autocomplete="off">
    <pre id="enTest">—</pre>
    <div class="en-row"><button id="enTestBtn">Test</button><button id="enSave" class="primary">Save</button><button id="enClose">Close</button></div></div>`;
  document.body.appendChild(modal);
  const openEngine = () => { $id("enAddr").value = EnglishEngine.addr(); $id("enTest").textContent = "—"; modal.hidden = false; };
  modal.onclick = e => { if (e.target === modal) modal.hidden = true; };
  $id("enClose").onclick = () => (modal.hidden = true);
  $id("enTestBtn").onclick = async () => {
    EnglishEngine.setAddr($id("enAddr").value); $id("enTest").textContent = "Testing…";
    try { const h = await EnglishEngine.health(); $id("enTest").textContent = `Connected ✓\ntext → sign: ${h.text2sign}\nsign → word: ${h.sign2word}`; refreshEngine(); }
    catch (e) { $id("enTest").textContent = "Not connected: " + e.message; refreshEngine(); }
  };
  $id("enSave").onclick = () => { EnglishEngine.setAddr($id("enAddr").value); modal.hidden = true; refreshEngine(); };

  // engine status bar (shown on English screens)
  const bars = [];
  function engineBar() {
    const d = document.createElement("div"); d.className = "en-engine en-only";
    d.innerHTML = '<i class="dot"></i><span>English engine: checking…</span><button>Engine</button>';
    d.querySelector("button").onclick = openEngine; bars.push(d); return d;
  }
  let engineOk = false;
  async function refreshEngine() {
    const set = (cls, txt) => bars.forEach(b => { b.className = "en-engine en-only " + cls; b.querySelector("span").textContent = txt; });
    if (!EnglishEngine.addr()) { engineOk = false; set("bad", "English engine: not set up - tap Engine"); return; }
    try {
      const h = await EnglishEngine.health();
      engineOk = /ready/.test(h.text2sign);
      const t = /ready/.test(h.text2sign) ? "text→sign ✓" : "text→sign ✗", s = /ready/.test(h.sign2word) ? "sign→word ✓" : "sign→word ✗";
      set(engineOk ? "ok" : "bad", `Engine ${EnglishEngine.addr()} · ${t} · ${s}`);
    } catch (e) { engineOk = false; set("bad", "English engine offline - start server.py on your PC, then tap Engine"); }
  }

  // ------------------------------------------------------------------ TRANSLATE (English)
  const vt = $id("view-translate");
  const stageCard = vt.querySelector(".stage-card");
  [vt.querySelector(".askbar"), $id("list"), vt.querySelector(".sentence-card"), $id("recentWrap"), $id("favBtn")].forEach(e => e && e.classList.add("bn-only"));
  const enAsk = document.createElement("div"); enAsk.className = "askbar en-only";
  enAsk.innerHTML = '<input id="enQ" placeholder="Type an English sentence…" autocomplete="off" enterkeyhint="go" lang="en">' +
    '<button id="enMic" class="icon" aria-label="Speak English"></button><button id="enGo" class="primary">Sign</button>';
  const enSug = document.createElement("ul"); enSug.id = "enSuggest"; enSug.className = "cards en-only";
  vt.insertBefore(engineBar(), stageCard); vt.insertBefore(enAsk, stageCard); vt.insertBefore(enSug, stageCard);
  const micSrc = $id("mic"); $id("enMic").innerHTML = micSrc && micSrc.innerHTML.includes("svg") ? micSrc.innerHTML : "🎤";
  const enCard = document.createElement("div"); enCard.className = "sentence-card en-only"; enCard.dataset.label = "English → gloss (generated by Motion-S)";
  enCard.innerHTML = '<p id="enSentence">Type a sentence and tap Sign.</p><div id="enGloss" class="chips"></div><small id="enMeta" class="en-meta"></small>';
  const enRecent = document.createElement("div"); enRecent.className = "en-only";
  enRecent.innerHTML = '<h3>Recent</h3><div id="enRecent" class="chips"></div>';
  const scrub = $id("scrub"); (scrub || vt.lastChild).after(enCard); enCard.after(enRecent);

  let sentences = null;
  async function loadSentences() {
    if (sentences) return sentences;
    try { sentences = await (await fetch("en/sentences.json")).json(); } catch (e) { sentences = []; }
    return sentences;
  }
  function overlay(on, text) {
    let o = stageCard.querySelector(".en-gen");
    if (on && !o) { o = document.createElement("div"); o.className = "en-gen"; stageCard.appendChild(o); }
    if (o) { o.hidden = !on; if (on) o.innerHTML = `<div><i></i>${esc(text)}</div>`; }
  }
  let genId = 0;
  async function playEnglish(text, player = main, opts = {}) {
    text = String(text || "").trim(); if (!text) return null;
    const id = ++genId;
    if (player === main) {
      $id("enSentence").textContent = text; $id("enGloss").innerHTML = ""; $id("enMeta").textContent = "";
      overlay(true, "Generating the sign with your Motion-S model…");
    }
    try {
      const r = await EnglishEngine.textToPose(text);
      if (id !== genId && player === main) return null;
      player.loop = opts.loop !== false; player.set(r.pose);
      if (player === main) {
        overlay(false); const e = $id("empty"); if (e) e.hidden = true;
        $id("enGloss").innerHTML = r.gloss.split(/\s+/).map(g => `<span>${esc(g)}</span>`).join("");
        $id("enMeta").textContent = `${r.pose.frames} frames · ${r.pose.fps} fps` + (r.ms ? ` · generated in ${(r.ms / 1000).toFixed(1)} s` : " · from cache");
        const b = $id("badge"); if (b) { b.hidden = false; b.textContent = "Generated"; b.style.background = "var(--primary)"; }
        pushRecent(text);
      }
      return r;
    } catch (e) {
      if (player === main) { overlay(false); $id("enMeta").textContent = "⚠ " + e.message; }
      say(e.message); refreshEngine(); return null;
    }
  }
  SignLang.playEnglish = playEnglish;
  function goEnglish(text) { if (typeof switchView === "function") switchView("translate"); $id("enQ").value = text; enSug.innerHTML = ""; playEnglish(text); }
  SignLang.goEnglish = goEnglish;

  $id("enGo").onclick = () => { enSug.innerHTML = ""; playEnglish($id("enQ").value); };
  $id("enQ").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $id("enGo").click(); } });
  $id("enQ").addEventListener("input", async () => {
    const q = $id("enQ").value.trim().toLowerCase(); enSug.innerHTML = "";
    if (q.length < 2) return;
    const list = await loadSentences(), hits = [];
    for (const [s, g] of list) { if (s.toLowerCase().includes(q)) { hits.push([s, g]); if (hits.length >= 5) break; } }
    hits.forEach(([s, g]) => {
      const li = document.createElement("li"); const t = document.createElement("span"); t.textContent = s;
      const p = document.createElement("span"); p.className = "pct"; p.textContent = g.split(" ").length + " signs";
      li.append(t, p); li.onclick = () => goEnglish(s); enSug.appendChild(li);
    });
  });
  let recent = ls.get("bdsl_en_recent", []);
  function pushRecent(t) { recent = [t, ...recent.filter(x => x !== t)].slice(0, 8); ls.set("bdsl_en_recent", recent); renderRecent(); }
  function renderRecent() {
    const box = $id("enRecent"); box.innerHTML = ""; enRecent.hidden = !recent.length;
    recent.forEach(t => { const b = document.createElement("button"); b.textContent = t; b.onclick = () => goEnglish(t); box.appendChild(b); });
  }
  renderRecent();

  // English speech input
  $id("enMic").onclick = () => listen("en-US", t => { $id("enQ").value = t; playEnglish(t); });
  async function listen(code, done) {
    const native = window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.SpeechRecognition;
    try {
      if (native) {
        await native.requestPermissions();
        const r = await native.start({ language: code, maxResults: 1, popup: true, partialResults: false });
        if (r && r.matches && r.matches[0]) done(r.matches[0]); return;
      }
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { say("Voice input is not available here - type instead."); return; }
      const r = new SR(); r.lang = code; r.interimResults = false;
      r.onresult = e => done(e.results[0][0].transcript); r.onerror = () => say("Could not hear you. Try again.");
      r.start(); say("Listening…");
    } catch (e) { say("Voice input failed: " + e.message); }
  }
  SignLang.listen = listen;

  // ------------------------------------------------------------------ LIBRARY (English sentences of the Motion-S dataset)
  const vb = $id("view-browse");
  [...vb.children].forEach(c => { if (!c.classList.contains("pg-head")) c.classList.add("bn-only"); });
  const enLib = document.createElement("div"); enLib.className = "en-only";
  enLib.innerHTML = '<div class="askbar"><input id="enBq" placeholder="Search English sentences…" autocomplete="off"></div>' +
    '<ul id="enBlist" class="cards"></ul><button id="enMore" class="chip wide" hidden>Show more</button>';
  vb.appendChild(enLib);
  let libLimit = 40;
  async function renderLib() {
    const list = await loadSentences(), q = $id("enBq").value.trim().toLowerCase(), ul = $id("enBlist");
    const hits = q ? list.filter(([s, g]) => s.toLowerCase().includes(q) || g.toLowerCase().includes(q)) : list;
    ul.innerHTML = "";
    hits.slice(0, libLimit).forEach(([s, g]) => {
      const li = document.createElement("li"); const t = document.createElement("span");
      t.innerHTML = `${esc(s)}<br><small style="color:var(--muted)">${esc(g)}</small>`;
      li.append(t); li.onclick = () => goEnglish(s); ul.appendChild(li);
    });
    $id("enMore").hidden = hits.length <= libLimit;
  }
  $id("enBq").addEventListener("input", () => { libLimit = 40; renderLib(); });
  $id("enMore").onclick = () => { libLimit += 40; renderLib(); };

  // ------------------------------------------------------------------ PRACTICE -> "Learn ASL" (watch, try with the camera, quiz)
  const vp = $id("view-practice");
  ["score", "q", "opts", "feedback", "next"].forEach(k => { const e = vp.querySelector("." + k) || $id(k); if (e) e.classList.add("bn-only"); });
  const learn = document.createElement("div"); learn.className = "en-only";
  learn.innerHTML = `
    <div class="seg" id="enLearnSeg" style="margin:12px 0 4px"><button data-m="words" class="on">Learn words</button><button data-m="quiz">Quiz</button></div>
    <div id="enLearnWords">
      <div class="en-learn-card"><h4 id="enWord">Pick a word</h4><p id="enWordInfo">Watch the generated sign, then tap “Try it” and sign it to the camera.</p>
        <div class="en-row"><button id="enWatch" disabled>▶ Watch again</button><button id="enTry" class="primary" disabled>🤟 Try it</button></div></div>
      <div class="askbar"><input id="enWq" placeholder="Search 250 ASL words…" autocomplete="off"></div>
      <h3>ASL words <small id="enLearned"></small></h3>
      <div id="enWords" class="en-words"></div>
    </div>
    <div id="enQuiz" hidden>
      <div class="en-learn-card"><h4>What word is this?</h4><p id="enQuizInfo">Tap Start. The model signs a word - pick the right one.</p>
        <div id="enQuizOpts" class="en-quiz-opts"></div>
        <div class="en-row" style="margin-top:10px"><button id="enQuizNext" class="primary">Start</button><span id="enQuizScore" style="align-self:center;color:var(--muted)"></span></div></div>
    </div>`;
  (vp.querySelector(".controls") || vp.lastChild).after(learn);
  vp.insertBefore(engineBar(), vp.querySelector(".stage-card"));

  let words = [], curWord = null, learned = new Set(ls.get("bdsl_en_learned", []));
  async function loadWords() {
    if (words.length) return words;
    try { words = await (await fetch("en/asl_words.json")).json(); } catch (e) { words = []; }
    return words;
  }
  async function renderWords() {
    await loadWords();
    const q = $id("enWq").value.trim().toLowerCase(), box = $id("enWords"); box.innerHTML = "";
    words.filter(w => !q || w.toLowerCase().includes(q)).forEach(w => {
      const b = document.createElement("button"); b.textContent = w;
      b.className = (learned.has(w) ? "done " : "") + (w === curWord ? "cur" : "");
      b.onclick = () => pickWord(w); box.appendChild(b);
    });
    $id("enLearned").textContent = `· ${learned.size}/${words.length} practised`;
  }
  async function pickWord(w) {
    curWord = w; $id("enWord").textContent = w; $id("enWordInfo").textContent = "Generating…"; renderWords();
    const r = await playEnglish(w, practice);
    $id("enWatch").disabled = $id("enTry").disabled = !r;
    $id("enWordInfo").textContent = r ? `Gloss: ${r.gloss} · ${r.pose.frames} frames. Now tap “Try it” and sign it.` : "Could not generate - check the English engine.";
  }
  $id("enWq").addEventListener("input", renderWords);
  $id("enWatch").onclick = () => { if (practice.pose) { practice.pos = 0; practice.playing = true; } };
  $id("enTry").onclick = () => { if (curWord) startTarget(curWord); };
  $id("enLearnSeg").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    [...$id("enLearnSeg").children].forEach(x => x.classList.toggle("on", x === b));
    $id("enLearnWords").hidden = b.dataset.m !== "words"; $id("enQuiz").hidden = b.dataset.m !== "quiz";
  };
  // quiz
  const quiz = { right: 0, total: 0, answer: null, done: false };
  $id("enQuizNext").onclick = async () => {
    await loadWords(); if (words.length < 4) return;
    const pick = [...words].sort(() => Math.random() - 0.5).slice(0, 4), ans = pick[0];
    quiz.answer = ans; quiz.done = false; $id("enQuizOpts").innerHTML = ""; $id("enQuizInfo").textContent = "Generating…";
    $id("enQuizNext").disabled = true;
    const r = await playEnglish(ans, practice); $id("enQuizNext").disabled = false; $id("enQuizNext").textContent = "Next ▶";
    if (!r) { $id("enQuizInfo").textContent = "Could not generate - check the English engine."; return; }
    $id("enQuizInfo").textContent = "Watch the signer. Which word is it?";
    pick.sort(() => Math.random() - 0.5).forEach(w => {
      const b = document.createElement("button"); b.textContent = w;
      b.onclick = () => {
        if (quiz.done) return; quiz.done = true; quiz.total++;
        if (w === ans) { quiz.right++; b.classList.add("right"); } else { b.classList.add("wrong"); [...$id("enQuizOpts").children].find(x => x.textContent === ans).classList.add("right"); }
        $id("enQuizScore").textContent = `${quiz.right}/${quiz.total} correct`;
      };
      $id("enQuizOpts").appendChild(b);
    });
  };

  // ------------------------------------------------------------------ CAMERA: "Try it" target + results
  const vs = $id("view-sign");
  const target = document.createElement("div"); target.className = "en-target en-only"; target.hidden = true;
  target.innerHTML = '<span>Sign this word:</span><b id="enTargetWord"></b><button id="enTargetDone">Done</button>';
  vs.insertBefore(target, vs.querySelector(".cam-card"));
  vs.insertBefore(engineBar(), target);
  let targetWord = null;
  function startTarget(w) {
    targetWord = w; $id("enTargetWord").textContent = w; target.hidden = false;
    if (typeof switchView === "function") switchView("sign");
    say(`Start the camera, tap Record, sign “${w}”, tap Stop`);
  }
  $id("enTargetDone").onclick = () => { targetWord = null; target.hidden = true; if (typeof switchView === "function") switchView("practice"); };
  document.addEventListener("sign-result", e => {
    if (lang !== "en" || !targetWord) return;
    const top = e.detail || [], i = top.findIndex(t => t.word.toLowerCase() === targetWord.toLowerCase());
    if (i === 0) { say(`✓ Correct! That was “${targetWord}”`); learned.add(targetWord); ls.set("bdsl_en_learned", [...learned]); renderWords(); }
    else if (i > 0) say(`Close - “${targetWord}” was guess #${i + 1}. Try again.`);
    else say(`Not recognised as “${targetWord}”. Watch it again and retry.`);
  });

  // ------------------------------------------------------------------ apply language to the whole app
  const HEADS = {
    bn: { translate: ["Translate", "Type or say Bangla and watch it signed"], browse: ["Library", "Every sentence in the dataset"],
          practice: ["Practice", "Watch the sign, pick the sentence"], sign: ["Sign to text", "Sign a word to the camera, build a sentence"] },
    en: { translate: ["Translate", "Type or say English - your generative model signs it (ASL)"], browse: ["Library", "12,000+ English sentences from Motion-S"],
          practice: ["Learn ASL", "Watch a word, sign it back, take a quiz"], sign: ["Sign to text", "Sign an ASL word (250-word vocabulary)"] },
  };
  function apply() {
    document.body.classList.toggle("lang-en", lang === "en");
    document.documentElement.lang = lang === "en" ? "en" : "bn";
    seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.l === lang));
    for (const [v, [h, p]] of Object.entries(HEADS[lang])) {
      const head = document.querySelector(`#view-${v} .pg-head`);
      if (head) { head.querySelector("h2").textContent = h; head.querySelector("p").textContent = p; }
    }
    const tab = document.querySelector('.tabs button[data-v="practice"]');
    if (tab) { const n = [...tab.childNodes].find(n => n.nodeType === 3); if (n) n.textContent = lang === "en" ? "Learn" : "Practice"; }
    const count = $id("count");
    if (count) {
      if (lang === "en") { if (count.textContent !== "English · ASL") count.dataset.bn = count.textContent; count.textContent = "English · ASL"; }
      else if (count.dataset.bn) count.textContent = count.dataset.bn;
    }
    // the BdSL stage content does not belong to English (and back)
    const b = $id("badge"); if (b) { b.hidden = true; b.style.background = ""; }
    overlay(false);
    if (lang === "en") {
      main.set(null); practice.set(null); const e = $id("empty"); if (e) { e.hidden = false; e.textContent = "Type an English sentence to see it signed 👆"; }
      refreshEngine(); renderLib(); renderWords();
    } else {
      targetWord = null; target.hidden = true;
      const e = $id("empty"); if (e) e.textContent = "Type or pick a sentence to see it signed 👆";
      if (typeof current !== "undefined" && current && typeof show === "function") show(current, null);
      else { main.set(null); const e2 = $id("empty"); if (e2) e2.hidden = false; }
      practice.set(null);
      if (origRound && typeof practiceStarted !== "undefined" && practiceStarted) origRound();
    }
  }
  // keep app.js from loading a Bangla quiz onto the practice stage while English is on
  const origRound = typeof newRound === "function" ? newRound : null;
  if (origRound) window.newRound = function () { if (lang === "en") return; return origRound.apply(this, arguments); };
  // the count line is rewritten by app.js after loading; keep the original for Bangla
  const countEl = $id("count");
  if (countEl) new MutationObserver(() => { if (lang === "en" && countEl.textContent !== "English · ASL") { countEl.dataset.bn = countEl.textContent; countEl.textContent = "English · ASL"; } })
    .observe(countEl, { childList: true, characterData: true, subtree: true });
  setInterval(() => { if (lang === "en" && !document.hidden) refreshEngine(); }, 30000);
  apply();
  document.dispatchEvent(new CustomEvent("lang-change", { detail: lang }));
})();
