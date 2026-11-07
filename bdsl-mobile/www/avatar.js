// ======================= avatar.js : nicer signing avatar + smoother, real-time playback =======================
// Load AFTER core.js and app.js. It replaces drawAvatar() (core.js) and patches the Player (app.js), so every
// avatar in the app (Translate, Practice, Call) gets the new look and the speed fixes. Nothing else changes.
//
// Look: styled like a sign-language interpreter - dark, plain, long-sleeved top so the hands stand out,
// natural skin tone, simple friendly face, hands drawn with palm + jointed fingers, nearer hand drawn on top.
// Speed:  1) playback follows real time (on a slow phone it skips frames instead of playing in slow motion)
//         2) the canvas is drawn at most at 2x pixel density (phones are often 3x = 2.25x more pixels to paint)
//         3) it only repaints when the pose frame actually changes (30 fps data, not every screen refresh)
(function () {
  "use strict";
  const PAL = {
    light: { skin: "#e8b48e", skinLit: "#f3c9a6", skinShade: "#c98b65", line: "rgba(96,52,30,.55)", hair: "#211a16", hairLit: "#3a2e27",
             top: "#253552", top2: "#18233a", topLine: "rgba(8,12,24,.55)", cuff: "#2f4266", eye: "#1e1e24", brow: "#2a211c", lip: "#b8645a",
             floor: "rgba(30,30,70,.08)", rim: null },
    dark:  { skin: "#e3ad86", skinLit: "#efc19d", skinShade: "#bf8460", line: "rgba(60,30,16,.6)", hair: "#17120f", hairLit: "#2f2520",
             top: "#2b3d5f", top2: "#1c2843", topLine: "rgba(0,0,0,.6)", cuff: "#38507b", eye: "#151519", brow: "#211a16", lip: "#b05e55",
             floor: "rgba(0,0,0,.28)", rim: "rgba(255,255,255,.14)" },
  };
  const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  const PALM = [0, 1, 5, 9, 13, 17];

  // Some recordings come out vertically stretched (camera aspect ratio). Measure once per clip how high the
  // nose sits above the shoulders and squash/stretch the whole clip so the body has human proportions.
  // It is one factor for the whole clip, so hand-to-face contacts stay exactly where they were.
  function bodyAspect(pose) {
    if (pose._ay) return pose._ay;
    const D = pose.data, NP = pose.points, r = [];
    for (let f = 0; f < pose.frames; f += 2) {
      const b = f * NP * 3, g = i => D[b + i * 3] / 32767 * 4, h = i => D[b + i * 3 + 1] / 32767 * 4;
      const sw = Math.hypot(g(1) - g(2), h(1) - h(2)), up = (h(1) + h(2)) / 2 - h(0);
      if (sw > 0.2 && up > 0.05) r.push(up / sw);
    }
    r.sort((a, b) => a - b);
    const med = r.length ? r[r.length >> 1] : 0.6;
    return (pose._ay = Math.max(0.55, Math.min(1.15, 0.6 / med)));
  }

  function drawAvatarPro(ctx, pose, f, w, h, opt = {}) {
    const C = PAL[opt.dark ? "dark" : "light"], mirror = !!opt.mirror;
    ctx.clearRect(0, 0, w, h);
    const k = Math.min(w / 3.5, h / 3.8), ox = w / 2, oy = h * 0.47, D = pose.data, NP = pose.points, base = f * NP * 3;
    const ay = bodyAspect(pose);
    const P = i => { const j = base + i * 3; const x = D[j] / 32767 * 4, y = D[j + 1] / 32767 * 4 * ay; return [ox + (mirror ? -x : x) * k, oy + y * k]; };
    const Z = i => D[base + i * 3 + 2] / 32767 * 4;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const seg = (a, b, wd, col) => { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineWidth = wd; ctx.strokeStyle = col; ctx.stroke(); };
    const poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); };

    const A = P(1), B = P(2);                                  // shoulders
    const [sl, sr] = A[0] <= B[0] ? [A, B] : [B, A];           // left / right ON SCREEN
    const u = Math.max(k * 0.6, dist(sl, sr));                 // one shoulder width in pixels
    const sc = mid(sl, sr);

    // floor shadow
    const fs = ctx.createRadialGradient(sc[0], h, 0, sc[0], h, u * 1.6);
    fs.addColorStop(0, C.floor); fs.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = fs; ctx.fillRect(0, h - u * 1.6, w, u * 1.6);

    // ---- torso (long-sleeved top, rounded shoulders, gently tapering) ----
    const bottom = h + 4, ex = 0.14 * u;                       // body is a bit wider than the shoulder joints
    const L0 = [sl[0] - ex, sl[1] + 0.12 * u], R0 = [sr[0] + ex, sr[1] + 0.12 * u];
    ctx.beginPath();
    ctx.moveTo(L0[0], L0[1]);
    ctx.quadraticCurveTo(sl[0] - ex * 0.9, sl[1] - 0.14 * u, sl[0] + 0.18 * u, sl[1] - 0.15 * u);
    ctx.quadraticCurveTo(sc[0], sc[1] - 0.2 * u, sr[0] - 0.18 * u, sr[1] - 0.15 * u);
    ctx.quadraticCurveTo(sr[0] + ex * 0.9, sr[1] - 0.14 * u, R0[0], R0[1]);
    ctx.bezierCurveTo(R0[0] + 0.02 * u, sc[1] + 0.8 * u, sr[0] - 0.04 * u, sc[1] + 1.2 * u, sr[0] - 0.02 * u, bottom);
    ctx.lineTo(sl[0] + 0.02 * u, bottom);
    ctx.bezierCurveTo(sl[0] + 0.04 * u, sc[1] + 1.2 * u, L0[0] - 0.02 * u, sc[1] + 0.8 * u, L0[0], L0[1]);
    ctx.closePath();
    const tg = ctx.createLinearGradient(0, sc[1] - 0.2 * u, 0, bottom);
    tg.addColorStop(0, C.top); tg.addColorStop(1, C.top2);
    ctx.fillStyle = tg; ctx.fill();
    ctx.lineWidth = Math.max(1, u * 0.02); ctx.strokeStyle = C.rim || C.topLine; ctx.stroke();
    // centre seam / placket hint
    ctx.beginPath(); ctx.moveTo(sc[0], sc[1] + 0.05 * u); ctx.lineTo(sc[0], Math.min(bottom, sc[1] + 1.6 * u));
    ctx.lineWidth = Math.max(1, u * 0.012); ctx.strokeStyle = C.topLine; ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;

    // ---- head position (follows the nose, sits above the shoulders) ----
    const N = P(0);
    const hx = sc[0] + Math.max(-0.28 * u, Math.min(0.28 * u, N[0] - sc[0]));
    const hy = Math.min(N[1] - 0.04 * u, sc[1] - 0.5 * u);
    const rx = 0.29 * u, ry = 0.36 * u;

    // neck + collar
    const neckTop = hy + ry * 0.7, neckBot = sc[1] - 0.06 * u;
    const ng = ctx.createLinearGradient(0, neckTop, 0, neckBot);
    ng.addColorStop(0, C.skinShade); ng.addColorStop(0.35, C.skin); ng.addColorStop(1, C.skinShade);
    ctx.fillStyle = ng; ctx.beginPath();
    ctx.moveTo(hx - 0.13 * u, neckTop); ctx.lineTo(hx + 0.13 * u, neckTop);
    ctx.lineTo(sc[0] + 0.16 * u, neckBot); ctx.lineTo(sc[0] - 0.16 * u, neckBot); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.ellipse(sc[0], neckBot, 0.2 * u, 0.08 * u, 0, 0, Math.PI);
    ctx.lineWidth = 0.035 * u; ctx.strokeStyle = C.cuff; ctx.stroke();

    // ears
    ctx.fillStyle = C.skinShade;
    [-1, 1].forEach(s => { ctx.beginPath(); ctx.ellipse(hx + s * rx * 0.98, hy + ry * 0.05, rx * 0.16, ry * 0.2, 0, 0, Math.PI * 2); ctx.fill(); });
    // face
    const fg = ctx.createRadialGradient(hx - rx * 0.3, hy - ry * 0.35, rx * 0.1, hx, hy, ry * 1.1);
    fg.addColorStop(0, C.skinLit); fg.addColorStop(0.6, C.skin); fg.addColorStop(1, C.skinShade);
    ctx.fillStyle = fg; ctx.beginPath(); ctx.ellipse(hx, hy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    // hair (cap + side part)
    const hg = ctx.createLinearGradient(hx - rx, hy - ry, hx + rx, hy);
    hg.addColorStop(0, C.hairLit); hg.addColorStop(1, C.hair);
    ctx.fillStyle = hg; ctx.beginPath();
    ctx.moveTo(hx - rx * 1.04, hy + ry * 0.05);
    ctx.bezierCurveTo(hx - rx * 1.12, hy - ry * 1.25, hx + rx * 1.12, hy - ry * 1.25, hx + rx * 1.04, hy + ry * 0.05);
    ctx.bezierCurveTo(hx + rx * 0.95, hy - ry * 0.42, hx + rx * 0.2, hy - ry * 0.62, hx - rx * 0.28, hy - ry * 0.5);
    ctx.bezierCurveTo(hx - rx * 0.62, hy - ry * 0.42, hx - rx * 0.92, hy - ry * 0.3, hx - rx * 1.04, hy + ry * 0.05);
    ctx.fill();
    // brows, eyes, nose, mouth
    ctx.strokeStyle = C.brow; ctx.lineWidth = 0.035 * u;
    [-1, 1].forEach(s => { ctx.beginPath(); ctx.moveTo(hx + s * rx * 0.2, hy - ry * 0.2); ctx.quadraticCurveTo(hx + s * rx * 0.42, hy - ry * 0.3, hx + s * rx * 0.62, hy - ry * 0.2); ctx.stroke(); });
    [-1, 1].forEach(s => {
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(hx + s * rx * 0.4, hy - ry * 0.02, rx * 0.15, ry * 0.075, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.eye; ctx.beginPath(); ctx.arc(hx + s * rx * 0.4, hy - ry * 0.02, rx * 0.075, 0, Math.PI * 2); ctx.fill();
    });
    ctx.strokeStyle = C.skinShade; ctx.lineWidth = 0.03 * u;
    ctx.beginPath(); ctx.moveTo(hx, hy + ry * 0.05); ctx.quadraticCurveTo(hx - rx * 0.1, hy + ry * 0.3, hx + rx * 0.06, hy + ry * 0.32); ctx.stroke();
    ctx.strokeStyle = C.lip; ctx.lineWidth = 0.04 * u;
    ctx.beginPath(); ctx.moveTo(hx - rx * 0.3, hy + ry * 0.52); ctx.quadraticCurveTo(hx, hy + ry * 0.68, hx + rx * 0.3, hy + ry * 0.52); ctx.stroke();

    // ---- arms + hands, the nearer side drawn last (MediaPipe z: smaller = closer to the camera) ----
    const sides = [
      { s: 1, e: 3, wr: 5, hand: 9 },
      { s: 2, e: 4, wr: 6, hand: 30 },
    ].map(a => ({ ...a, z: (Z(a.wr) + Z(a.hand)) / 2 })).sort((a, b) => b.z - a.z);

    sides.forEach(a => {
      const S = P(a.s), E = P(a.e), Wp = P(a.wr), Hw = P(a.hand);
      const W = dist(Wp, Hw) < 0.45 * u ? Hw : Wp;             // join the sleeve to the hand when they agree
      // sleeve: outline then fill, upper arm a little wider than forearm
      seg(S, E, 0.33 * u, C.topLine); seg(E, W, 0.27 * u, C.topLine);
      seg(S, E, 0.30 * u, C.top);     seg(E, W, 0.24 * u, C.top);
      // cuff
      const dx = W[0] - E[0], dy = W[1] - E[1], L = Math.hypot(dx, dy) || 1;
      const cuffA = [W[0] - dx / L * 0.1 * u, W[1] - dy / L * 0.1 * u];
      seg(cuffA, W, 0.25 * u, C.cuff);
      drawHand(a.hand);
    });

    function drawHand(off) {
      const pts = []; for (let i = 0; i < 21; i++) pts.push(P(off + i));
      const span = Math.max(0.12 * u, dist(pts[0], pts[9]));   // wrist -> middle knuckle = hand size
      const fw = Math.min(0.085 * u, span * 0.22);             // finger thickness from the real hand size
      // palm
      const palm = PALM.map(i => pts[i]);
      poly(palm); ctx.closePath();
      ctx.lineWidth = fw * 1.55; ctx.strokeStyle = C.line; ctx.stroke();
      ctx.fillStyle = C.skin; ctx.fill();
      ctx.lineWidth = fw * 1.25; ctx.strokeStyle = C.skin; ctx.stroke();
      // fingers: outline, then skin, then a light top edge; thumb a bit thicker
      FINGERS.forEach((chain, n) => {
        const pp = chain.map(i => pts[i]), wd = n === 0 ? fw * 1.12 : fw * (n === 4 ? 0.86 : 1);
        poly(pp); ctx.lineWidth = wd + Math.max(1.2, fw * 0.28); ctx.strokeStyle = C.line; ctx.stroke();
      });
      FINGERS.forEach((chain, n) => {
        const pp = chain.map(i => pts[i]), wd = n === 0 ? fw * 1.12 : fw * (n === 4 ? 0.86 : 1);
        poly(pp); ctx.lineWidth = wd; ctx.strokeStyle = C.skin; ctx.stroke();
        poly(pp); ctx.lineWidth = wd * 0.35; ctx.strokeStyle = C.skinLit; ctx.globalAlpha = 0.55; ctx.stroke(); ctx.globalAlpha = 1;
      });
    }
  }

  // replace core.js's drawAvatar for the whole app
  window.drawAvatar = drawAvatarPro;
  window.bdslBodyAspect = bodyAspect;
  window.drawAvatar2D = drawAvatarPro;                       // kept as the fallback for the 3D avatar (avatar3d.js)
  try { drawAvatar = drawAvatarPro; } catch (e) {}           // the global function binding used by Player.draw

  // ---------- Player speed fixes (app.js) ----------
  if (typeof Player !== "undefined") {
    const PP = Player.prototype;
    window.__players = window.__players || new Set();
    PP.resize = function () {
      window.__players.add(this);
      const r = this.c.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
      this.c.width = Math.max(1, Math.round(r.width * d)); this.c.height = Math.max(1, Math.round(r.height * d));
      this._f = -1; this.draw();
    };
    PP.set = function (pose) { this.pose = pose; this.pos = 0; this.playing = true; this._f = -1; this.draw(); };
    PP.draw = function () {
      if (!this.pose) { this.ctx.clearRect(0, 0, this.c.width, this.c.height); this._f = -1; return; }
      this._f = this.frame();
      (window.drawAvatar || drawAvatarPro)(this.ctx, this.pose, this._f, this.c.width, this.c.height,
        { dark: typeof dark !== "undefined" && dark, mirror: typeof mirror !== "undefined" && mirror });
    };
    PP.tick = function (t) {
      const dt = this.last ? Math.min(1, (t - this.last) / 1000) : 0; this.last = t;   // real time (was capped at 0.1 s)
      if (this.pose && this.playing && this.c.offsetParent !== null) {
        this.pos += dt * this.pose.fps * this.speed;
        if (this.pos >= this.pose.frames) {
          if (this.loop) this.pos %= this.pose.frames; else { this.pos = this.pose.frames - 1; this.playing = false; }
        }
        if (this.frame() !== this._f) this.draw();               // repaint only when the pose frame changes
        if (this.onTick) this.onTick(this);
      }
      requestAnimationFrame(x => this.tick(x));
    };
    try { if (typeof main !== "undefined") main.resize(); if (typeof practice !== "undefined") practice.resize(); } catch (e) {}
  }
})();
