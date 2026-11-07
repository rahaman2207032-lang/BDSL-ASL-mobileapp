// ======================= call-mini.js : minimise an ongoing call (like WhatsApp) =======================
// Load AFTER call.js. Adds a "minimise" button to the call screen. While minimised:
//  - a green "Tap to return to call" bar sits at the top, with the timer and an End button
//  - a small floating video (drag it anywhere) shows the other person - or the signing avatar
//    when a message arrives - tap it to go back
//  - every tab works normally; the call, captions, signing avatar and transcript keep running.
// Tapping the Calls tab, the bar, or the floating video returns to the call. Android back = minimise.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const active = $("callActive");
  if (!active) return;

  const css = document.createElement("style");
  css.textContent = `
  .cx-minb { width: 40px; height: 40px; min-width: 40px; min-height: 40px; border-radius: 50%; padding: 0; display: grid; place-items: center;
    background: rgba(255,255,255,.12); color: #fff; box-shadow: none; }
  .cx-minb svg { width: 24px; height: 24px; }
  body.cx-minimized #callActive { visibility: hidden !important; pointer-events: none !important; }
  body.cx-minimized #callActive * { visibility: hidden !important; }
  #callReturn { position: fixed; z-index: 55; left: 0; right: 0; top: 0; display: flex; align-items: center; gap: 10px;
    padding: calc(8px + env(safe-area-inset-top)) 12px 8px 16px; background: linear-gradient(90deg, #0f8a5f, #16a34a); color: #fff;
    font-size: .88rem; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.18); animation: cmDown .25s ease-out; }
  #callReturn[hidden] { display: none !important; }
  #callReturn .dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: cmBlink 1.2s ease-in-out infinite; flex: none; }
  #callReturn .txt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #callReturn .txt b { font-weight: 700; }
  #callReturn .txt.msg { animation: cmFlash .6s ease-out 2; }
  #callReturn .end { height: 32px; min-height: 32px; padding: 0 14px; border-radius: 999px; background: #e5484d; color: #fff; font-weight: 700; font-size: .8rem; box-shadow: none; }
  body.cx-minimized .top { top: calc(48px + env(safe-area-inset-top)); }
  body.cx-minimized { padding-top: 48px; }
  #callPip { position: fixed; z-index: 54; width: 112px; aspect-ratio: 3 / 4; border-radius: 18px; overflow: hidden; background: #0b141a;
    box-shadow: 0 10px 30px rgba(0,0,0,.35); border: 2px solid rgba(255,255,255,.9); touch-action: none; cursor: grab; animation: cmPop .25s ease-out;
    transition: left .25s ease, top .25s ease; }
  #callPip.drag { transition: none; cursor: grabbing; }
  #callPip[hidden] { display: none !important; }
  #callPip #remoteVid { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  #callPip canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  #callPip canvas.sign { background: linear-gradient(160deg, #eef0ff, #f7efff); }
  #callPip .who { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 2.2rem; font-weight: 700; background: #128c7e; }
  #callPip .lbl { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 6px 5px; font-size: .68rem; color: #fff; text-align: center;
    background: linear-gradient(transparent, rgba(0,0,0,.7)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #callPip.ping { animation: cmPing .9s ease-out; }
  @keyframes cmDown { from { transform: translateY(-100%); } to { transform: none; } }
  @keyframes cmPop { from { transform: scale(.6); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes cmBlink { 50% { opacity: .3; } }
  @keyframes cmFlash { 50% { opacity: .4; } }
  @keyframes cmPing { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.7), 0 10px 30px rgba(0,0,0,.35); } 100% { box-shadow: 0 0 0 18px rgba(34,197,94,0), 0 10px 30px rgba(0,0,0,.35); } }`;
  document.head.appendChild(css);

  // ---- minimise button (top-left of the call screen) ----
  const bar = active.querySelector(".cx-bar");
  let minBtn = $("callMinBtn");
  if (!minBtn && bar) {
    minBtn = document.createElement("button"); minBtn.id = "callMinBtn"; minBtn.className = "cx-minb"; minBtn.setAttribute("aria-label", "Minimise call");
    minBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    bar.insertBefore(minBtn, bar.firstChild);
  }

  // ---- return bar + floating video ----
  const ret = document.createElement("div"); ret.id = "callReturn"; ret.hidden = true;
  ret.innerHTML = '<span class="dot"></span><span class="txt"></span><button class="end" type="button">End</button>';
  const pip = document.createElement("div"); pip.id = "callPip"; pip.hidden = true;
  pip.innerHTML = '<canvas hidden></canvas><div class="who" hidden></div><div class="lbl"></div>';
  document.body.append(ret, pip);
  const pc = pip.querySelector("canvas"), who = pip.querySelector(".who"), lbl = pip.querySelector(".lbl");
  const txt = ret.querySelector(".txt");

  let rvHome = null, rvNext = null, mini = false, lastMsg = 0, msgText = "", raf = 0;
  const callName = () => ($("callName") && $("callName").textContent.trim()) || "Friend";
  const timer = () => ($("callTimer") && $("callTimer").textContent.trim()) || "";
  const isOn = () => !active.hidden;

  function minimise() {
    if (!isOn() || mini) return;
    mini = true; document.body.classList.add("cx-minimized"); document.body.classList.remove("cx-lock");
    ret.hidden = false; pip.hidden = false;
    // the real remote <video> moves into the floating window (no second decoder, no re-connect)
    const rv = $("remoteVid"); if (rv) { rvHome = rv.parentNode; rvNext = rv.nextSibling; pip.insertBefore(rv, pip.firstChild); rv.play && rv.play().catch(() => {}); }
    placePip(); paint(); loop();
  }
  function restore() {
    if (!mini) return;
    mini = false; document.body.classList.remove("cx-minimized");
    if (isOn()) document.body.classList.add("cx-lock");
    ret.hidden = true; pip.hidden = true; cancelAnimationFrame(raf);
    const rv = $("remoteVid"); if (rv) rv.style.visibility = ""; if (rv && rvHome) { rvHome.insertBefore(rv, rvNext && rvNext.parentNode === rvHome ? rvNext : rvHome.firstChild); rv.play && rv.play().catch(() => {}); }
  }
  window.CallMini = { minimise, restore, isMinimised: () => mini };

  minBtn && (minBtn.onclick = e => { e.stopPropagation(); minimise(); });
  ret.addEventListener("click", e => { if (e.target.closest(".end")) return; restore(); });
  ret.querySelector(".end").onclick = e => { e.stopPropagation(); const h = $("hangBtn"); restore(); h && h.click(); };

  // Calls tab while minimised -> back into the call
  const callTab = document.querySelector('.tabs button[data-v="call"]');
  callTab && callTab.addEventListener("click", () => { if (mini) setTimeout(restore, 0); });

  // call ended / screen changed -> clean up; keep a green dot on the Calls tab during a call
  new MutationObserver(() => {
    if (!isOn() && mini) restore();
    if (callTab) {
      let d = callTab.querySelector(".live");
      if (isOn() && !d) { d = document.createElement("span"); d.className = "live"; callTab.appendChild(d); }
      if (!isOn() && d) d.remove();
    }
  }).observe(active, { attributes: true, attributeFilter: ["hidden"] });

  // new caption = new message -> show it on the bar and the floating window
  const cap = $("callCaption");
  cap && new MutationObserver(() => {
    const t = cap.textContent.trim(); if (!t) return;
    const s = cap.querySelector("small"); msgText = s ? t.replace(s.textContent, s.textContent + ": ") : t;
    lastMsg = Date.now();
    if (mini) { txt.classList.remove("msg"); void txt.offsetWidth; txt.classList.add("msg"); pip.classList.remove("ping"); void pip.offsetWidth; pip.classList.add("ping"); }
  }).observe(cap, { childList: true });

  function paint() {
    if (!mini) return;
    const recent = Date.now() - lastMsg < 12000;
    txt.innerHTML = ""; const b = document.createElement("b");
    if (recent && msgText) { b.textContent = msgText; txt.append(b); txt.classList.add("msg"); }
    else { b.textContent = callName(); txt.append(b, document.createTextNode(` · ${timer()} · Tap to return`)); txt.classList.remove("msg"); }
    // what the floating window shows: the avatar while a sign plays, otherwise their video 
    const box = $("callSignBox"), av = $("callAvatar"), rv = $("remoteVid");
    const showSign = recent && box && !box.hidden && av && av.width > 0;
    const hasVideo = rv && rv.srcObject && rv.videoWidth > 0 && $("remoteWait") && $("remoteWait").hidden;
    const src = showSign ? av : null;
    pc.hidden = !src; pc.classList.toggle("sign", !!showSign);
    if (rv) rv.style.visibility = hasVideo && !showSign ? "visible" : "hidden";
    who.hidden = !!src || hasVideo; who.textContent = callName().trim().charAt(0).toUpperCase() || "?";
    lbl.textContent = showSign ? "Signing…" : timer();
    if (src) {
      if (pc.width !== 224) { pc.width = 224; pc.height = 298; }
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      const g = pc.getContext("2d"), s = Math.max(pc.width / sw, pc.height / sh), w = sw * s, h = sh * s;
      g.clearRect(0, 0, pc.width, pc.height);
      try { g.drawImage(src, (pc.width - w) / 2, (pc.height - h) / 2, w, h); } catch (e) {}
    }
  }
  let lastPaint = 0;
  function loop(t) { if (!mini) return; if (!t || t - lastPaint > 66) { lastPaint = t || 0; paint(); } raf = requestAnimationFrame(loop); }

  // ---- drag the floating window, it snaps to the nearest side ----
  let pos = null;
  function placePip() {
    const w = pip.offsetWidth || 112, h = pip.offsetHeight || 150;
    const minTop = 60 + (parseInt(getComputedStyle(document.body).paddingTop) || 0), maxTop = innerHeight - h - 96;
    if (!pos) pos = { right: true, top: maxTop };
    pos.top = Math.max(minTop, Math.min(maxTop, pos.top));
    pip.style.left = (pos.right ? innerWidth - w - 12 : 12) + "px"; pip.style.top = pos.top + "px";
  }
  let drag = null;
  pip.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, l: pip.offsetLeft, t: pip.offsetTop, moved: false }; pip.setPointerCapture(e.pointerId); });
  pip.addEventListener("pointermove", e => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; pip.classList.add("drag"); }
    if (drag.moved) { pip.style.left = drag.l + dx + "px"; pip.style.top = drag.t + dy + "px"; }
  });
  pip.addEventListener("pointerup", () => {
    if (!drag) return; const moved = drag.moved; drag = null; pip.classList.remove("drag");
    if (!moved) { restore(); return; }
    pos = { right: pip.offsetLeft + pip.offsetWidth / 2 > innerWidth / 2, top: pip.offsetTop }; placePip();
  });
  addEventListener("resize", () => mini && placePip());

  // ---- Android back button: minimise the call instead of closing the app ----
  try {
    const App = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App;
    if (App && App.addListener) App.addListener("backButton", ({ canGoBack }) => {
      if (isOn() && !mini) return minimise();
      const tr = document.querySelector('.tabs button[data-v="translate"]');
      if (!document.querySelector("#view-translate.active") && tr) return tr.click();
      if (canGoBack) history.back(); else App.exitApp();
    });
  } catch (e) {}
})();
