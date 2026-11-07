// ======================= call.js : WhatsApp-style video calls with sign <-> text =======================
// How it works (plain words):
//  * PeerJS gives every phone a 6-digit "call code" on a free public server (the phone book). Calling a code
//    connects the two phones DIRECTLY (WebRTC): video goes phone-to-phone, plus a small message channel.
//  * Signing person (role "sign"): signs words with the same word model as the Camera tab -> Send ->
//    the words pop up on BOTH screens (and are read aloud for a speaking person, if the phone can).
//  * Speaking person (role "speak"): speaks or types Bangla -> Send -> the text AND the matching sign
//    animation (from the Ban-Sign-Sent pack) appear on BOTH screens.
//  * The in-call layout depends on who signs and who speaks, and changes live when either person switches.
// Needs: lib/peerjs.min.js (global Peer), sign-engine.js, and from app.js: toast, rank, manifest, getPose, Player.
(function () {
  "use strict";
  const ID_PREFIX = "bdsl-sign-player-";      // keeps our codes apart from other PeerJS apps
  const RING_TIMEOUT = 40000;                  // ms before "no answer"
  const CONF_MIN = 0.35;
  // ---------------------------------------------------------------------------------------------
  // Calls on DIFFERENT networks need a TURN relay. Left empty = STUN only = same Wi-Fi calls.
  const TURN_CREDENTIALS_URL = "";   // e.g. "https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_API_KEY"
  const TURN_SERVERS = [
    // { urls: ["turn:relay1.expressturn.com:3478?transport=udp", "turn:relay1.expressturn.com:3478?transport=tcp"], username: "YOUR_USERNAME", credential: "YOUR_PASSWORD" },
  ];
  const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  const CONNECT_TIMEOUT = 15000, VIDEO_TIMEOUT = 20000;
  // ---------------------------------------------------------------------------------------------

  const st = (typeof store !== "undefined") ? store : {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  const el = id => document.getElementById(id);
  const say = msg => (typeof toast === "function" ? toast(msg) : console.log(msg));
  if (!el("view-call")) { console.error("[call] index.html has no Call section - run node tools/add_call_tab.js"); return; }

  // The three full-screen call screens live directly in <body>, so they show over ANY tab.
  ["callOutgoing", "callIncoming", "callActive"].forEach(id => { if (el(id)) document.body.appendChild(el(id)); });

  // ---------- state ----------
  let myCode = st.get("bdsl_call_code", null);
  if (!/^\d{6}$/.test(myCode || "")) { myCode = String(Math.floor(100000 + Math.random() * 900000)); st.set("bdsl_call_code", myCode); }
  let myRole = st.get("bdsl_call_role", "sign");
  let peer = null, conn = null, media = null, localStream = null, inCall = false, accepted = false;
  let peerName = "", peerRole = "sign", peerCode = "", draft = [], lastTop = null, avatar = null, readAloud = true;
  let micMuted = false, peerMuted = false, uiProblem = "", relayOn = false;
  let ringTimer = null, connTimer = null, videoTimer = null, clockTimer = null, captionTimer = null, callStart = 0;
  let record = null;                              // the call being made, for the history list

  // ---------- helpers ----------
  const COLORS = ["#128c7e", "#5b4bdb", "#e67e22", "#c0392b", "#2980b9", "#8e44ad", "#16a085", "#d35400"];
  function paintAvatar(node, name) {
    const n = String(name || "?").trim() || "?";
    let h = 0; for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    node.textContent = [...n][0].toUpperCase(); node.style.background = COLORS[h % COLORS.length];
  }
  const modeText = r => r === "speak" ? "🗣️ Speaking" : "🤟 Signing";
  const two = n => String(n).padStart(2, "0");
  const fmtDur = s => `${Math.floor(s / 60)}:${two(s % 60)}`;
  function setStatus(t, ok) { el("peerStatus").textContent = t; el("peerStatus").className = "cx-status " + (ok ? "on" : "off"); }
  function show(name) {                           // "home" | "outgoing" | "incoming" | "active"
    el("callOutgoing").hidden = name !== "outgoing";
    el("callIncoming").hidden = name !== "incoming";
    el("callActive").hidden = name !== "active";
    document.body.classList.toggle("cx-lock", name !== "home");
  }

  // ---------- ringtones (soft tones made in code; silent if the phone blocks audio) ----------
  let actx = null, toneTimer = null, vibTimer = null;
  function beep(freqs, ms) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const g = actx.createGain(); g.gain.value = 0.07; g.connect(actx.destination);
      freqs.forEach(f => { const o = actx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); o.stop(actx.currentTime + ms / 1000); });
    } catch (e) {}
  }
  function startTone(kind) {
    stopTone();
    const play = kind === "incoming" ? () => { beep([660, 880], 350); setTimeout(() => beep([660, 880], 350), 500); } : () => beep([440, 480], 1600);
    play(); toneTimer = setInterval(play, kind === "incoming" ? 2500 : 4000);
    if (kind === "incoming") {
      const v = () => { try { navigator.vibrate && navigator.vibrate([500, 300, 500]); } catch (e) {} };
      v(); vibTimer = setInterval(v, 2500);
    }
  }
  function stopTone() { clearInterval(toneTimer); clearInterval(vibTimer); try { navigator.vibrate && navigator.vibrate(0); } catch (e) {} }

  // ---------- call history ----------
  function addHistory(r) {
    const list = st.get("bdsl_call_history", []);
    list.unshift(r); st.set("bdsl_call_history", list.slice(0, 25)); renderHistory();
  }
  function renderHistory() {
    const list = st.get("bdsl_call_history", []), ul = el("callHistory"); ul.innerHTML = "";
    ul.hidden = !list.length; el("historyEmpty").hidden = !!list.length;
    list.forEach(r => {
      const li = document.createElement("li");
      const av = document.createElement("div"); av.className = "cx-av sm"; paintAvatar(av, r.name || r.code);
      const who = document.createElement("div"); who.className = "cx-who";
      const b = document.createElement("b"); b.textContent = r.name || r.code;
      const s = document.createElement("small");
      const when = new Date(r.t), today = new Date().toDateString() === when.toDateString();
      const time = today ? `${two(when.getHours())}:${two(when.getMinutes())}` : when.toLocaleDateString();
      const kind = { out: "↗ Outgoing", in: "↙ Incoming", missed: "↙ Missed", declined: "↙ Declined", noanswer: "↗ No answer", cancelled: "↗ Cancelled" }[r.dir] || r.dir;
      s.textContent = `${kind} · ${time}` + (r.dur ? ` · ${fmtDur(r.dur)}` : "") + ` · ${r.code}`;
      if (r.dir === "missed") s.className = "miss";
      who.append(b, s);
      const again = document.createElement("button"); again.className = "cx-again"; again.textContent = "📹"; again.setAttribute("aria-label", "Call again");
      li.append(av, who, again);
      li.onclick = () => { el("dialCode").value = r.code; dial(); };
      ul.appendChild(li);
    });
  }

  // ---------- connect to the phone book ----------
  async function iceServers() {
    let turn = TURN_SERVERS.slice();
    if (TURN_CREDENTIALS_URL) {
      try {
        const r = await Promise.race([fetch(TURN_CREDENTIALS_URL), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000))]);
        const j = await r.json(); const list = Array.isArray(j) ? j : j && j.iceServers ? [].concat(j.iceServers) : [];
        turn = turn.concat(list.map(x => ({ ...x, urls: [].concat(x.urls || x.url).filter(u => !/:53(\?|$)/.test(u)) })));
      } catch (e) { console.warn("[call] could not load TURN credentials:", e.message); }
    }
    relayOn = turn.some(x => [].concat(x.urls || x.url || "").some(u => /^turns?:/.test(u)));
    return STUN_SERVERS.concat(turn);
  }

  let starting = false;
  // Asks the relay for an address with the saved username/password. Success = calls work across networks.
  let relayWorks = null;
  // Resolves { ok, why }:  ok = the relay gave us an address (login + network fine).
  function relayCheck(ice) {
    return new Promise(resolve => {
      let pc, done = false; const errs = [];
      const end = ok => {
        if (done) return; done = true; try { pc.close(); } catch (e) {}
        let why = "";
        if (!ok) {
          const codes = errs.map(e => e.code);
          if (codes.includes(401)) why = "wrong TURN username or password";
          else if (codes.some(c => c === 701 || c === 0)) why = "this network cannot reach the relay (port 3478 blocked, or wrong server name)";
          else why = errs.length ? errs.map(e => e.code + " " + e.text).join(", ") : "no answer from the relay";
        }
        console.log("[call] relay check:", ok ? "OK" : "FAILED - " + why, errs);
        resolve({ ok, why });
      };
      try {
        pc = new RTCPeerConnection({ iceServers: ice.filter(s => [].concat(s.urls).some(u => /^turns?:/.test(u))), iceTransportPolicy: "relay" });
        pc.onicecandidateerror = e => errs.push({ code: e.errorCode, text: e.errorText, url: e.url });
        pc.createDataChannel("t");
        pc.onicecandidate = e => { if (e.candidate && / typ relay /.test(e.candidate.candidate)) end(true); };
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") setTimeout(() => end(false), 300); };
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => end(false));
        setTimeout(() => end(false), 10000);
      } catch (e) { errs.push({ code: -1, text: e.message }); end(false); }
    });
  }

  async function startPeer() {
    if (typeof Peer === "undefined") { setStatus("Calling library missing (run node tools/copy_call_libs.js)", false); return; }
    if ((peer && !peer.destroyed) || starting) return;
    starting = true; setStatus("Connecting…", false);
    const ice = await iceServers(); starting = false;
    peer = new Peer(ID_PREFIX + myCode, { config: { iceServers: ice }, debug: 1 });
    peer.on("open", () => {
      setStatus(uiProblem || (relayOn ? "Online · checking relay…" : "Online · same Wi-Fi"), !uiProblem);
      if (relayOn && !uiProblem) relayCheck(ice).then(r => {
        relayWorks = r.ok;
        if (peer && peer.open && !uiProblem) setStatus(r.ok ? "Online · any network" : "Online · relay failed: " + r.why, true);
      });
    });
    peer.on("disconnected", () => { setStatus("Reconnecting…", false); setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 2000); });
    peer.on("error", err => {
      const t = err && err.type;
      if (t === "unavailable-id") {
        myCode = String(Math.floor(100000 + Math.random() * 900000)); st.set("bdsl_call_code", myCode);
        el("myCode").textContent = myCode; try { peer.destroy(); } catch (e) {} peer = null; startPeer();
      } else if (t === "peer-unavailable") {
        finish("noanswer", "Nobody is online with that code. They must have the app open.");
      } else if (t === "network" || t === "server-error" || t === "socket-error" || t === "socket-closed") {
        setStatus("Offline", false);
        setTimeout(() => { if (peer && peer.disconnected && !peer.destroyed) try { peer.reconnect(); } catch (e) {} }, 4000);
      } else { console.warn("[call]", err); }
    });
    peer.on("connection", c => {
      if (conn) { c.on("open", () => { c.send({ type: "busy" }); setTimeout(() => c.close(), 800); }); return; }
      conn = c; wireConn(c);
    });
    peer.on("call", mc => {
      if (!accepted || !localStream) { mc.close(); return; }
      media = mc; wireMedia(mc); mc.answer(localStream);
    });
  }

  function wireConn(c) {
    c.on("data", onData);
    c.on("close", () => { if (conn === c) finish(inCall ? null : (record && record.dir === "in" ? "missed" : "noanswer"), inCall ? "Call ended" : ""); });
    c.on("error", e => console.warn("[call] data", e));
  }
  function wireMedia(mc) {
    mc.on("stream", s => {
      clearTimeout(videoTimer); el("remoteVid").srcObject = s; el("remoteVid").play().catch(() => {}); el("remoteWait").hidden = true;
      if (!callStart) startClock();
    });
    clearTimeout(videoTimer);
    videoTimer = setTimeout(() => {
      if (!el("remoteVid").srcObject) el("remoteWait").textContent = relayOn
        ? "Video can't get through yet - check both phones' internet"
        : "Video can't get through. Different networks need a TURN relay.";
    }, VIDEO_TIMEOUT);
    mc.on("close", () => { if (media === mc) finish(null, "Call ended"); });
    mc.on("error", e => console.warn("[call] media", e));
  }

  async function getStream() {
    const v = { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } };
    try { return await navigator.mediaDevices.getUserMedia({ video: v, audio: true }); }
    catch (e) {
      console.warn("[call] microphone not available:", e && e.name, e && e.message);
      return await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    }
  }

  // ---------- making a call ----------
  function dial() {
    const code = el("dialCode").value.replace(/\D/g, "");
    if (code.length !== 6) { say("Enter your friend's 6-digit code."); return; }
    if (code === myCode) { say("That is your own code."); return; }
    if (!peer || !peer.open) { say("Not online yet - wait for the green dot."); return; }
    if (conn) return;
    saveMe();
    const known = st.get("bdsl_call_history", []).find(r => r.code === code);
    peerCode = code; peerName = known && known.name || "";
    record = { code, name: peerName, dir: "out", t: Date.now(), dur: 0 };
    conn = peer.connect(ID_PREFIX + code, { reliable: true });
    wireConn(conn);
    conn.on("open", () => { clearTimeout(connTimer); el("outState").textContent = "Ringing…"; conn.send({ type: "ring", name: myName(), role: myRole, lang: myLang() }); });
    connTimer = setTimeout(() => {
      if (conn && !conn.open) finish("noanswer", relayOn
        ? "Could not reach your friend's phone. Check both phones' internet and try again."
        : "Could not reach your friend's phone. Calls on different networks need a TURN relay.");
    }, CONNECT_TIMEOUT);
    paintAvatar(el("outAv"), peerName || code);
    el("outName").textContent = peerName || code; el("outState").textContent = "Calling…"; el("outMode").textContent = "You: " + modeText(myRole);
    show("outgoing"); startTone("outgoing");
    ringTimer = setTimeout(() => { if (!inCall) { sendSafe({ type: "cancel" }); finish("noanswer", "No answer."); } }, RING_TIMEOUT);
  }

  async function onData(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "ring") {
      peerName = String(m.name || "Someone").slice(0, 40); peerRole = m.role === "speak" ? "speak" : "sign";
      peerCode = String(conn && conn.peer || "").replace(ID_PREFIX, "");
      record = { code: peerCode, name: peerName, dir: "in", t: Date.now(), dur: 0 };
      callLang = m.lang === "en" ? "en" : "bn";
      paintAvatar(el("inAv"), peerName); el("inName").textContent = peerName;
      el("inMode").textContent = modeText(peerRole) + " · " + (window.SignLang ? SignLang.label(callLang) : "") + " · " + peerCode;
      pickSeg("answerSeg", myRole);
      show("incoming"); startTone("incoming");
    } else if (m.type === "accept") {
      clearTimeout(ringTimer); stopTone();
      peerName = String(m.name || peerName || "Friend").slice(0, 40); peerRole = m.role === "speak" ? "speak" : "sign";
      if (record) record.name = peerName;
      el("outState").textContent = "Connecting…";
      try {
        localStream = await getStream();
        media = peer.call(conn.peer, localStream); wireMedia(media);
        enterCall();
      } catch (e) { sendSafe({ type: "hangup" }); finish(null, "Could not open the camera: " + e.message); }
    } else if (m.type === "decline") finish("declined", `${peerName || "They"} declined the call.`);
    else if (m.type === "busy") finish("noanswer", "They are in another call.");
    else if (m.type === "cancel") finish("missed", "Missed call from " + (peerName || "someone"));
    else if (m.type === "hangup") finish(null, (peerName || "They") + " ended the call.");
    else if (m.type === "msg") showMessage(m, false);
    else if (m.type === "mute") { peerMuted = !!m.muted; updateBar(); }
    else if (m.type === "lang") say(`${peerName || "Your friend"} switched to ${window.SignLang ? SignLang.label(m.lang) : m.lang}`);
    else if (m.type === "role") {
      const before = peerRole; peerRole = m.role === "speak" ? "speak" : "sign"; updateLayout();
      if (before !== peerRole) say(`${peerName || "Your friend"} switched to ${peerRole === "speak" ? "speaking / typing" : "signing"}`);
    }
  }

  async function accept() {
    stopTone(); saveMe();
    try { localStream = await getStream(); }
    catch (e) { say("Camera permission is needed for calls."); decline(); return; }
    accepted = true;
    // the call uses the caller's sign language: switch to it if this phone was set to the other one
    if (window.SignLang && SignLang.get() !== callLang) { SignLang.set(callLang); say("Switched to " + SignLang.label(callLang) + " for this call"); }
    sendSafe({ type: "accept", name: myName(), role: myRole, lang: myLang() });
    enterCall();
  }
  function decline() { sendSafe({ type: "decline" }); finish("declined", ""); }

  // ---------- in the call ----------
  function enterCall() {
    inCall = true; stopTone(); show("active");
    if (record) record.answered = true;
    el("localVid").srcObject = localStream; el("localVid").play().catch(() => {});
    el("remoteWait").hidden = !!el("remoteVid").srcObject;
    if (!el("remoteVid").srcObject) el("remoteWait").textContent = "Connecting video…";
    el("callLog").innerHTML = ""; el("callCaption").innerHTML = ""; el("chatDot").hidden = true; el("callLogWrap").hidden = true;
    draft = []; lastTop = null; renderDraft(false);
    paintAvatar(el("callAv"), peerName || peerCode); el("callName").textContent = peerName || peerCode;
    el("callTimer").textContent = "00:00"; callStart = 0;
    micMuted = false; peerMuted = false; setMic(); updateBar(); applyRole();
  }
  function startClock() {
    callStart = Date.now(); clearInterval(clockTimer);
    clockTimer = setInterval(() => { const s = Math.floor((Date.now() - callStart) / 1000); el("callTimer").textContent = `${two(Math.floor(s / 60))}:${two(s % 60)}`; }, 1000);
  }
  function updateBar() {
    el("peerModeLbl").textContent = modeText(peerRole);
    el("peerMutedLbl").hidden = !peerMuted;
  }

  // The layout follows who signs and who speaks: pair-dd (both sign), pair-ds (I sign, they speak),
  // pair-sd (I speak, they sign), pair-ss (both speak). It changes live when either person switches.
  function updateLayout() {
    const a = el("callActive"), me = myRole === "sign" ? "d" : "s", them = peerRole === "sign" ? "d" : "s";
    a.className = `cx-full me-${myRole} pair-${me}${them}`;
    el("pairBadge").textContent = { dd: "🤟 Sign ↔ Sign 🤟", ds: "🤟 You sign · they speak 🗣️", sd: "🗣️ You speak · they sign 🤟", ss: "🗣️ Voice & text" }[me + them];
    el("roleSwitch").querySelector(".i").textContent = myRole === "sign" ? "⌨️" : "🤟";
    el("roleSwitch").querySelector("small").textContent = myRole === "sign" ? "Type" : "Sign";
    updateBar();
  }

  function applyRole() {
    updateLayout();
    if (myRole === "sign" && inCall) {
      el("cSignBtn").disabled = true; el("signState").textContent = "Getting sign recognition ready…";
      SignEngine.init(t => { el("signState").textContent = t; })
        .then(() => { if (!inCall || myRole !== "sign") return; SignEngine.attach(el("localVid")); el("cSignBtn").disabled = false; el("signState").textContent = "Tap 🤟, sign one word, tap again"; })
        .catch(e => { el("signState").textContent = "Sign recognition could not load: " + e.message; });
    } else if (typeof SignEngine !== "undefined") SignEngine.detach();
  }

  // ---------- mute ----------
  function setMic() {
    const tracks = localStream ? localStream.getAudioTracks() : [];
    tracks.forEach(t => { t.enabled = !micMuted; });
    const b = el("muteBtn");
    if (!tracks.length) { b.querySelector(".i").textContent = "🚫"; b.querySelector("small").textContent = "No mic"; b.classList.remove("on"); el("muteBadge").hidden = true; return; }
    b.querySelector(".i").textContent = micMuted ? "🔇" : "🎤"; b.querySelector("small").textContent = micMuted ? "Unmute" : "Mute";
    b.classList.toggle("on", micMuted); el("muteBadge").hidden = !micMuted;
  }
  function toggleMute() {
    if (!localStream) return;
    if (!localStream.getAudioTracks().length) {
      say("No microphone in this call. Allow Microphone for BdSL Sign Player in phone Settings > Apps > Permissions, then call again."); return;
    }
    micMuted = !micMuted; setMic(); sendSafe({ type: "mute", muted: micMuted });
  }

  // ---------- signing (deaf user) ----------
  async function toggleSign() {
    const b = el("cSignBtn");
    if (!SignEngine.isRecording()) { SignEngine.startRecording(); b.classList.add("rec"); b.textContent = "■"; el("signState").textContent = "Recording… sign one word"; return; }
    b.classList.remove("rec"); b.textContent = "🤟"; el("signState").textContent = "Recognizing…";
    try {
      const top = await SignEngine.stopRecording();
      if (!top) { el("signState").textContent = "Too short - record the whole sign."; return; }
      lastTop = top; const best = top[0], ok = best.p >= CONF_MIN;
      if (ok) draft.push(best.word);
      el("signState").textContent = ok ? `Added “${best.word}” · ${Math.round(best.p * 100)}%` : `Not sure - pick a word or sign again`;
      renderDraft(ok);
    } catch (e) { el("signState").textContent = "Recognition failed: " + e.message; }
  }
  function renderDraft(lastAdded) {
    el("cDraft").textContent = draft.length ? draft.join(" ") : "Your signed words appear here";
    el("cDraft").classList.toggle("muted", !draft.length);
    el("cSend").disabled = el("cUndo").disabled = !draft.length;
    const alts = el("cAlts"); alts.innerHTML = "";
    if (lastTop) lastTop.forEach((t, i) => {
      if (i === 0 && lastAdded) return;
      const b = document.createElement("button"); b.textContent = `${i === 0 ? "+ " : ""}${t.word} ${Math.round(t.p * 100)}%`;
      b.onclick = () => { if (lastAdded) draft.pop(); draft.push(t.word); lastTop = null; renderDraft(false); };
      alts.appendChild(b);
    });
  }

  // ---------- messages (both screens) ----------
  let callLang = "bn";
  function myLang() { return window.SignLang ? SignLang.get() : "bn"; }
  document.addEventListener("lang-change", () => { if (inCall) { sendSafe({ type: "lang", lang: myLang() }); applyRole(); } });
  document.addEventListener("lang-change", e => {           // call text box hint follows the language
    const c = document.getElementById("cText");
    if (c) c.placeholder = e.detail === "en" ? "Write something in English…" : "বাংলায় লিখুন…";
  });

  function send(text, via) {
    text = String(text || "").trim(); if (!text || !conn) return;
    const m = { type: "msg", text, via, name: myName(), role: myRole, lang: myLang(), t: Date.now() };
    sendSafe(m); showMessage(m, true);
  }
  function sendSafe(m) { try { if (conn && conn.open) conn.send(m); } catch (e) { console.warn(e); } }

  function showMessage(m, mine) {
    const text = String(m.text || "").slice(0, 500), via = m.via;
    const who = mine ? "You" : (m.name || peerName || "Friend");
    const verb = via === "sign" ? "signed" : via === "speech" ? "said" : "typed";
    // transcript bubble
    const row = document.createElement("div"); row.className = "cx-msg " + (mine ? "mine" : "");
    const sm = document.createElement("small"); sm.textContent = `${who} ${verb}`;
    const p = document.createElement("p"); p.textContent = text;
    const tm = document.createElement("time"); const d = new Date(m.t || Date.now()); tm.textContent = `${two(d.getHours())}:${two(d.getMinutes())}`;
    row.append(sm, p, tm); el("callLog").appendChild(row); el("callLog").scrollTop = el("callLog").scrollHeight;
    if (el("callLogWrap").hidden && !mine) el("chatDot").hidden = false;
    // live caption over the video
    const cap = el("callCaption"); cap.innerHTML = ""; cap.classList.remove("fade");
    const lbl = document.createElement("small"); lbl.textContent = `${who} ${verb}`;
    const span = document.createElement("span"); span.append(lbl, document.createTextNode(text)); cap.appendChild(span);
    clearTimeout(captionTimer); captionTimer = setTimeout(() => cap.classList.add("fade"), 12000);
    // spoken/typed Bangla -> sign animation on BOTH screens; signed words -> read aloud for a speaking person
    const lang = m.lang === "en" ? "en" : m.lang === "bn" ? "bn" : myLang();
    if (via !== "sign") playSign(text, lang); else el("callSignBox").hidden = true;
    if (!mine && via === "sign" && myRole === "speak" && readAloud) speak(text, lang);
  }

  async function playSign(text, lang) {
    const box = el("callSignBox");
    if (lang === "en") {                          // English: your generative model (english-server on the PC)
      try {
        el("callSignLabel").textContent = "Generating sign…"; box.hidden = false;
        if (!avatar) avatar = new Player(el("callAvatar"));
        const r = await EnglishEngine.textToPose(text);
        avatar.loop = true; avatar.set(r.pose); el("callSignLabel").textContent = r.gloss;
      } catch (e) { el("callSignLabel").textContent = "⚠ " + e.message; setTimeout(() => { box.hidden = true; }, 5000); }
      return;
    }
    if (typeof manifest === "undefined" || !manifest.length || typeof rank !== "function") { box.hidden = true; return; }
    const r = rank(text, manifest, 1)[0];
    if (!r || r.score < CONF_MIN) { box.hidden = true; return; }
    try {
      const pose = await getPose(r.m);
      box.hidden = false;
      if (!avatar) avatar = new Player(el("callAvatar"));
      avatar.loop = true; avatar.set(pose);
      el("callSignLabel").textContent = (r.score >= 0.999 ? "" : `${Math.round(r.score * 100)}% · `) + r.m.text;
    } catch (e) { box.hidden = true; }
  }

  function speak(text, lang) {
    try {
      if (!("speechSynthesis" in window)) return;
      const en = (lang || myLang()) === "en";
      const u = new SpeechSynthesisUtterance(text); u.lang = en ? "en-US" : "bn-BD";
      const v = speechSynthesis.getVoices().find(x => (en ? /^en/i : /^bn/i).test(x.lang)); if (v) u.voice = v;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }

  async function listen() {
    const native = window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Capacitor.Plugins.SpeechRecognition;
    try {
      if (native) {
        await native.requestPermissions();
        const r = await native.start({ language: myLang() === "en" ? "en-US" : "bn-BD", maxResults: 1, popup: true, partialResults: false });
        if (r && r.matches && r.matches[0]) send(r.matches[0], "speech");
        return;
      }
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { say("Voice input is not available here - type instead."); return; }
      const r = new SR(); r.lang = myLang() === "en" ? "en-US" : "bn-BD"; r.interimResults = false;
      r.onresult = e => send(e.results[0][0].transcript, "speech");
      r.onerror = () => say("Could not hear you. Try again.");
      r.start(); say(myLang() === "en" ? "Listening… speak English" : "Listening… speak Bangla");
    } catch (e) { say("Voice input failed: " + e.message); }
  }

  // ---------- ending ----------
  function hangUp() { sendSafe({ type: "hangup" }); finish(null, "Call ended"); }
  // dir: history type for calls that never connected ("missed", "declined", "noanswer", "cancelled"); null = decide here
  function finish(dir, reason) {
    clearTimeout(ringTimer); clearTimeout(connTimer); clearTimeout(videoTimer); clearInterval(clockTimer); clearTimeout(captionTimer); stopTone();
    if (record) {
      const r = record; record = null;
      r.dur = callStart ? Math.round((Date.now() - callStart) / 1000) : 0;
      r.dir = r.answered ? r.dir : (dir || (r.dir === "in" ? "missed" : "noanswer"));
      delete r.answered; r.name = r.name || peerName; addHistory(r);
    }
    const c = conn, mc = media; conn = null; media = null;
    try { mc && mc.close(); } catch (e) {}
    setTimeout(() => { try { c && c.close(); } catch (e) {} }, 300);
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null; inCall = false; accepted = false; lastTop = null; micMuted = false; peerMuted = false; callStart = 0;
    if (typeof SignEngine !== "undefined") SignEngine.detach();
    el("remoteVid").srcObject = null; el("localVid").srcObject = null; el("callSignBox").hidden = true;
    if (avatar) avatar.set(null);
    try { speechSynthesis.cancel(); } catch (e) {}
    show("home");
    if (reason) say(reason);
  }

  const myName = () => (el("myName").value.trim() || "Friend").slice(0, 40);
  function saveMe() { st.set("bdsl_call_name", el("myName").value.trim()); st.set("bdsl_call_role", myRole); paintAvatar(el("meAv"), el("myName").value || "?"); }
  function pickSeg(id, r) { document.querySelectorAll(`#${id} button`).forEach(x => x.classList.toggle("on", x.dataset.r === r)); }

  // ---------- go online first, then wire up the screen ----------
  show("home");
  startPeer();
  try {
    el("myCode").textContent = myCode;
    el("myName").value = st.get("bdsl_call_name", "");
    paintAvatar(el("meAv"), el("myName").value || "?");
    el("myName").addEventListener("input", saveMe);
    pickSeg("roleSeg", myRole);
    document.querySelectorAll("#roleSeg button").forEach(b => b.onclick = () => { myRole = b.dataset.r; saveMe(); pickSeg("roleSeg", myRole); });
    document.querySelectorAll("#answerSeg button").forEach(b => b.onclick = () => { myRole = b.dataset.r; pickSeg("answerSeg", myRole); pickSeg("roleSeg", myRole); saveMe(); });
    el("copyCode").onclick = () => { try { navigator.clipboard.writeText(myCode).then(() => say("Code copied")); } catch (e) { say("Your code: " + myCode); } };
    el("dialBtn").onclick = dial;
    el("dialCode").addEventListener("keydown", e => { if (e.key === "Enter") dial(); });
    el("cancelRing").onclick = () => { sendSafe({ type: "cancel" }); finish("cancelled", "Call cancelled"); };
    el("acceptBtn").onclick = accept;
    el("declineBtn").onclick = decline;
    el("hangBtn").onclick = hangUp;
    el("muteBtn").onclick = toggleMute;
    el("cSignBtn").onclick = toggleSign;
    el("cUndo").onclick = () => { draft.pop(); lastTop = null; renderDraft(false); };
    el("cSend").onclick = () => { send(draft.join(" "), "sign"); draft = []; lastTop = null; renderDraft(false); el("signState").textContent = "Sent ✓"; };
    el("cTextSend").onclick = () => { send(el("cText").value, "text"); el("cText").value = ""; };
    el("cText").addEventListener("keydown", e => { if (e.key === "Enter") el("cTextSend").click(); });
    el("cMic").onclick = listen;
    el("roleSwitch").onclick = () => { myRole = myRole === "sign" ? "speak" : "sign"; saveMe(); pickSeg("roleSeg", myRole); sendSafe({ type: "role", role: myRole }); applyRole(); };
    el("chatBtn").onclick = () => { const w = el("callLogWrap"); w.hidden = !w.hidden; el("chatBtn").classList.toggle("on", !w.hidden); if (!w.hidden) { el("chatDot").hidden = true; el("callLog").scrollTop = el("callLog").scrollHeight; } };
    el("closeLog").onclick = () => { el("callLogWrap").hidden = true; el("chatBtn").classList.remove("on"); };
    el("readAloud").onchange = e => { readAloud = e.target.checked; };
    window.addEventListener("beforeunload", () => { if (inCall || conn) sendSafe({ type: "hangup" }); });
    renderHistory();
  } catch (e) {
    console.error("[call] index.html does not match call.js:", e);
    uiProblem = "Call screen files do not match - run: node tools\\add_call_tab.js";
    setStatus(uiProblem, false);
  }
  window.BdslCall = { get code() { return myCode; }, end: hangUp };
})();
