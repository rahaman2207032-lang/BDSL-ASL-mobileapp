// ======================= core.js : text matching, pose file reader, avatar drawing =======================

// ---------- text helpers ----------
function normText(s) {
  return s.normalize("NFC").replace(/[।,.?!"'‘’“”:;()\-–]/g, " ").replace(/\s+/g, " ").trim();
}
function trigrams(s) {
  const t = " " + s + " ", set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}
// closest sentences to the query: [{m, score 0..1}]
function rank(query, items, k = 5) {
  const q = normText(query), qt = trigrams(q);
  return items
    .map(m => {
      let s = m.norm === q ? 1 : jaccard(qt, m.tri);
      if (m.norm !== q && q.length >= 2 && m.norm.includes(q)) s = Math.max(s, 0.6);   // partial typing
      return { m, score: s };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------- .bsl pose file ----------
function parsePose(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "BSL1") throw new Error("Not a BSL1 file");
  const frames = dv.getUint16(4, true), points = dv.getUint16(6, true), fps = dv.getUint8(8);
  return { frames, points, fps, data: new Int16Array(buf, 10, frames * points * 3) };
}
function pt(pose, f, p) {                         // x,y of point p in frame f, in shoulder-widths
  const i = (f * pose.points + p) * 3;
  return [pose.data[i] / 32767 * 4, pose.data[i + 1] / 32767 * 4];
}

// ---------- avatar ----------
const THEMES = {
  light: { skin: "#eab896", skinDark: "#c98f68", shirt: "#4f46e5", shirt2: "#3730a3", hair: "#2b2118" },
  dark:  { skin: "#e2ad88", skinDark: "#b9815a", shirt: "#7b74ff", shirt2: "#4c45c9", hair: "#1a1410" }
};
const FINGERS = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
const PALM = [0, 1, 5, 9, 13, 17];

function drawAvatar(ctx, pose, f, w, h, opt = {}) {
  const th = THEMES[opt.dark ? "dark" : "light"], mirror = !!opt.mirror;
  ctx.clearRect(0, 0, w, h);
  const k = Math.min(w / 4.4, h / 4.4), ox = w / 2, oy = h * 0.40;
  const P = i => { const [x, y] = pt(pose, f, i); return [ox + (mirror ? -x : x) * k, oy + y * k]; };
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const line = (pts, width, color) => {
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };

  // torso (runs down to the bottom edge of the picture)
  const S1 = P(1), S2 = P(2), H1 = P(7), H2 = P(8);
  const B1 = [S1[0], h + k], B2 = [S2[0], h + k];   // straight down to the bottom edge
  ctx.beginPath(); ctx.moveTo(S1[0], S1[1]); ctx.lineTo(S2[0], S2[1]); ctx.lineTo(B2[0], B2[1]); ctx.lineTo(B1[0], B1[1]); ctx.closePath();
  const g = ctx.createLinearGradient(0, S1[1], 0, h); g.addColorStop(0, th.shirt); g.addColorStop(1, th.shirt2);
  ctx.fillStyle = g; ctx.strokeStyle = g; ctx.lineWidth = k * 0.3; ctx.fill(); ctx.stroke();

  // neck + head
  const N = P(0), sc = [(S1[0] + S2[0]) / 2, (S1[1] + S2[1]) / 2], hc = [N[0], Math.min(N[1] - k * 0.04, sc[1] - k * 0.42)];
  ctx.beginPath(); ctx.ellipse(sc[0], sc[1] + k * 0.02, k * 0.2, k * 0.14, 0, 0, Math.PI); ctx.fillStyle = th.skin; ctx.fill();   // neckline
  line([sc, [hc[0], hc[1] + k * 0.2]], k * 0.2, th.skin);
  ctx.beginPath(); ctx.ellipse(hc[0], hc[1], k * 0.27, k * 0.34, 0, 0, Math.PI * 2); ctx.fillStyle = th.skin; ctx.fill();
  ctx.beginPath(); ctx.ellipse(hc[0], hc[1] - k * 0.04, k * 0.29, k * 0.34, 0, Math.PI, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = th.hair; ctx.fill();
  ctx.fillStyle = "#263238";
  [-1, 1].forEach(s => { ctx.beginPath(); ctx.arc(hc[0] + s * k * 0.1, hc[1] - k * 0.01, k * 0.03, 0, 7); ctx.fill(); });
  ctx.beginPath(); ctx.arc(hc[0], hc[1] + k * 0.07, k * 0.09, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.strokeStyle = "#8d5a44"; ctx.lineWidth = k * 0.025; ctx.stroke();

  // arms (sleeves)
  [[1, 3, 5], [2, 4, 6]].forEach(([s, e, wr]) => {
    line([P(s), P(e)], k * 0.21, th.shirt2);
    line([P(e), P(wr)], k * 0.17, th.shirt2);
  });

  // hands
  [9, 30].forEach(off => {
    const pa = PALM.map(i => P(off + i));
    ctx.beginPath(); pa.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
    ctx.fillStyle = th.skin; ctx.strokeStyle = th.skin; ctx.lineWidth = k * 0.05; ctx.fill(); ctx.stroke();
    FINGERS.forEach(fi => {
      const pts = fi.map(i => P(off + i));
      line(pts, k * 0.064, th.skinDark);
      line(pts, k * 0.046, th.skin);
    });
  });
}
