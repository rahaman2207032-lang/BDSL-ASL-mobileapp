// ======================= ui-pro.js : icons + page headings for the professional UI =======================
// Works with ui-pro.css. Never changes ids, so app.js / camera.js / call.js keep working exactly as before.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const P = {   // simple line icons (24x24, stroke = currentColor)
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2.5Z"/><path d="M8 7h7M8 11h5"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    camera: '<path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14"/><rect x="3" y="6" width="12" height="12" rx="2.5"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.13.96.36 1.9.7 2.8a2 2 0 0 1-.45 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.45c.9.34 1.84.57 2.8.7a2 2 0 0 1 1.7 2Z"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>',
    replay: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    mirror: '<path d="M12 3v18"/><path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
    play: '<path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor"/>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  };
  const icon = (n, cls = "") => `<svg class="ui-ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
  const setIcon = (id, n, label) => { const b = $(id); if (!b) return; b.innerHTML = icon(n) + (label ? `<span class="sr">${label}</span>` : ""); };

  // app bar
  const logo = document.querySelector(".logo"); if (logo) logo.innerHTML = icon("hand");
  const th = $("themeBtn"); if (th) th.innerHTML = icon("moon", "moon") + icon("sun", "sun");
  setIcon("mic", "mic", "Speak"); setIcon("replay", "replay", "Replay"); setIcon("pReplay", "replay", "Replay");
  setIcon("loopBtn", "loop", "Loop"); setIcon("mirrorBtn", "mirror", "Mirror");
  const top = document.querySelector(".top");
  addEventListener("scroll", () => top && top.classList.toggle("scrolled", scrollY > 4), { passive: true });

  // bottom navigation
  const TAB = { translate: ["hand", "Translate"], browse: ["book", "Library"], practice: ["target", "Practice"], sign: ["camera", "Camera"], call: ["phone", "Calls"] };
  document.querySelectorAll(".tabs button").forEach(b => {
    const t = TAB[b.dataset.v]; if (!t) return;
    b.innerHTML = `<span class="ti">${icon(t[0])}</span>${t[1]}`;
  });

  // page headings
  const HEAD = {
    translate: ["Translate", "Type or say Bangla and watch it signed"],
    browse: ["Library", "Every sentence in the dataset"],
    practice: ["Practice", "Watch the sign, pick the sentence"],
    sign: ["Sign to text", "Sign a word to the camera, build a sentence"],
  };
  for (const [v, [h, p]] of Object.entries(HEAD)) {
    const sec = $("view-" + v); if (!sec || sec.querySelector(".pg-head")) continue;
    const d = document.createElement("div"); d.className = "pg-head"; d.innerHTML = `<h2>${h}</h2><p>${p}</p>`;
    sec.insertBefore(d, sec.firstChild);
  }

  // card labels
  const sc = document.querySelector("#view-translate .sentence-card"); if (sc) sc.dataset.label = "Sentence & gloss";
  const camCards = document.querySelectorAll("#view-sign .sentence-card");
  if (camCards[0]) camCards[0].dataset.label = "Recognised word";

  // practice score tiles
  const score = document.querySelector("#view-practice .score");
  if (score && $("sc") && $("tot") && $("streak")) {
    const a = document.createElement("span"), b = document.createElement("span");
    a.innerHTML = "<small>Score</small>"; const va = document.createElement("div"); va.className = "v";
    const sl = document.createElement("i"); sl.textContent = "/"; va.append($("sc"), sl, $("tot")); a.appendChild(va);
    b.innerHTML = "<small>Streak 🔥</small>"; const vb = document.createElement("div"); vb.className = "v"; vb.append($("streak")); b.appendChild(vb);
    score.innerHTML = ""; score.append(a, b);
  }

  // play / pause button: icon follows the text app.js writes ("Play" / "Pause")
  const play = $("play");
  if (play) {
    const paint = () => {
      if (play.querySelector("svg")) return;
      const t = play.textContent.trim();
      play.innerHTML = icon(/pause/i.test(t) ? "pause" : "play") + `<span>${t}</span>`;
    };
    new MutationObserver(paint).observe(play, { childList: true, characterData: true, subtree: true }); paint();
  }

  // filled part of the position slider
  const scrub = $("scrub");
  if (scrub) {
    const fill = () => scrub.style.setProperty("--fill", (scrub.value / (scrub.max || 1000) * 100) + "%");
    scrub.addEventListener("input", fill); setInterval(fill, 150); fill();
  }
})();
