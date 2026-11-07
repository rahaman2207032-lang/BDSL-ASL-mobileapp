// ======================= recognize.js : sign landmarks -> Bangla word (runs on the phone) =======================
// A line-by-line JavaScript copy of Notebook 2 (v2):  normalize_seq -> resample_T -> to_features + hand_local
// -> GRUClassifier (LayerNorm -> 2-layer bidirectional GRU -> mean over time -> LayerNorm -> Linear).
// The weights come from tools/export_sign_model.py (sign_model.json + sign_gru.bin).
// If you change the feature pipeline in the notebook, change it here too.
(function (root) {
  "use strict";
  const POSE_N = 33, LH_N = 21, RH_N = 21, N_PTS = 75, L_SH = 11, R_SH = 12;

  const allZero = (f, p) => f[p * 3] === 0 && f[p * 3 + 1] === 0 && f[p * 3 + 2] === 0;

  // ---- fill_missing (Notebook 2 v3): a block (pose / left hand / right hand) that is all-zero in a frame was not
  // detected; fill it by linear interpolation between the nearest detected frames (np.interp: edges copy nearest).
  function fillMissing(seq) {
    const T = seq.length, out = seq.map(f => Float32Array.from(f));
    for (const [a, b] of [[0, POSE_N], [POSE_N, POSE_N + LH_N], [POSE_N + LH_N, N_PTS]]) {
      const present = [];
      for (let t = 0; t < T; t++) {
        let any = false;
        for (let p = a; p < b && !any; p++) if (!allZero(seq[t], p)) any = true;
        if (any) present.push(t);
      }
      if (present.length === 0 || present.length === T) continue;
      let k = 0;                                      // index into present: present[k] <= t < present[k+1]
      for (let t = 0; t < T; t++) {
        if (seq[t] && present.includes(t)) continue;
        while (k + 1 < present.length && present[k + 1] < t) k++;
        const lo = present[k], hi = present[Math.min(k + 1, present.length - 1)];
        for (let p = a * 3; p < b * 3; p++) {
          let v;
          if (t <= present[0]) v = seq[present[0]][p];
          else if (t >= present[present.length - 1]) v = seq[present[present.length - 1]][p];
          else v = seq[lo][p] + (seq[hi][p] - seq[lo][p]) * (t - lo) / (hi - lo);
          out[t][p] = v;
        }
      }
    }
    return out;
  }

  // ---- normalize_seq: centre on the neck, divide by shoulder width, level the shoulders ----
  function normalizeSeq(seq, rotNorm) {
    return seq.map(src => {
      const f = Float32Array.from(src);
      if (allZero(f, L_SH) || allZero(f, R_SH)) return f;
      const nx = (f[L_SH * 3] + f[R_SH * 3]) / 2, ny = (f[L_SH * 3 + 1] + f[R_SH * 3 + 1]) / 2,
            nz = (f[L_SH * 3 + 2] + f[R_SH * 3 + 2]) / 2;
      let sd = Math.hypot(f[L_SH * 3] - f[R_SH * 3], f[L_SH * 3 + 1] - f[R_SH * 3 + 1], f[L_SH * 3 + 2] - f[R_SH * 3 + 2]);
      if (!sd) sd = 1;
      const present = [];
      for (let p = 0; p < N_PTS; p++) if (!allZero(f, p)) present.push(p);
      for (const p of present) { f[p * 3] = (f[p * 3] - nx) / sd; f[p * 3 + 1] = (f[p * 3 + 1] - ny) / sd; f[p * 3 + 2] = (f[p * 3 + 2] - nz) / sd; }
      if (rotNorm) {
        const ang = Math.atan2(f[R_SH * 3 + 1] - f[L_SH * 3 + 1], f[R_SH * 3] - f[L_SH * 3]);
        const c = Math.cos(-ang), s = Math.sin(-ang);
        for (const p of present) { const x = f[p * 3], y = f[p * 3 + 1]; f[p * 3] = x * c - y * s; f[p * 3 + 1] = x * s + y * c; }
      }
      return f;
    });
  }

  // ---- resample_T: stretch / squeeze any clip to exactly T frames (linear interpolation) ----
  function resampleT(seq, T) {
    const T0 = seq.length, D = N_PTS * 3;
    if (T0 === 0) return Array.from({ length: T }, () => new Float32Array(D));
    if (T0 === T) return seq.map(f => Float32Array.from(f));
    const out = [];
    for (let i = 0; i < T; i++) {
      const idx = T === 1 ? 0 : i * (T0 - 1) / (T - 1);
      const lo = Math.floor(idx), hi = Math.min(lo + 1, T0 - 1), fr = idx - lo;
      const a = seq[lo], b = seq[hi], f = new Float32Array(D);
      for (let d = 0; d < D; d++) f[d] = a[d] * (1 - fr) + b[d] * fr;
      out.push(f);
    }
    return out;
  }

  // ---- to_features + hand_local: [position 225 | velocity 225 | wrist-centred hand shape 126] ----
  function features(seq, cfg) {
    const D = N_PTS * 3, T = seq.length, F = cfg.feat;
    const out = new Float32Array(T * F);
    for (let t = 0; t < T; t++) {
      const f = seq[t], prev = seq[t === 0 ? 0 : t - 1], row = t * F;
      let k = 0;
      for (let d = 0; d < D; d++) out[row + k++] = f[d];
      if (cfg.use_velocity) for (let d = 0; d < D; d++) out[row + k++] = f[d] - prev[d];
      if (cfg.hand_local) {
        for (const off of [POSE_N, POSE_N + LH_N]) {
          let any = false;
          for (let j = 0; j < LH_N && !any; j++) if (!allZero(f, off + j)) any = true;
          const w = off * 3, m = (off + 9) * 3;
          const span = Math.hypot(f[m] - f[w], f[m + 1] - f[w + 1], f[m + 2] - f[w + 2]);
          for (let j = 0; j < LH_N; j++) for (let c = 0; c < 3; c++)
            out[row + k++] = (any && span > 1e-6) ? (f[(off + j) * 3 + c] - f[w + c]) / span : 0;
        }
      }
      if (k !== F) throw new Error(`feature size ${k} but model expects ${F}`);
    }
    return out;
  }

  // ---- model maths ----
  function layerNorm(x, n, g, b, out) {           // one row of n values, eps = 1e-5 like PyTorch
    let mu = 0; for (let i = 0; i < n; i++) mu += x[i]; mu /= n;
    let v = 0; for (let i = 0; i < n; i++) v += (x[i] - mu) ** 2; v /= n;
    const inv = 1 / Math.sqrt(v + 1e-5);
    for (let i = 0; i < n; i++) out[i] = (x[i] - mu) * inv * g[i] + b[i];
    return out;
  }
  const sigmoid = x => 1 / (1 + Math.exp(-x));
  function dot(a, ai, b, bi, n) {                 // unrolled dot product (the hot loop)
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0;
    for (; i + 3 < n; i += 4) {
      s0 += a[ai + i] * b[bi + i]; s1 += a[ai + i + 1] * b[bi + i + 1];
      s2 += a[ai + i + 2] * b[bi + i + 2]; s3 += a[ai + i + 3] * b[bi + i + 3];
    }
    for (; i < n; i++) s0 += a[ai + i] * b[bi + i];
    return s0 + s1 + s2 + s3;
  }

  // one GRU direction over the whole sequence. x: T*inDim, writes hidden states into out (T*2H) at column offset col
  function gruDir(x, T, inDim, Wih, Whh, bih, bhh, H, reverse, out, col) {
    const G = 3 * H, gi = new Float32Array(T * G);
    for (let t = 0; t < T; t++)                                   // input part, all frames at once
      for (let r = 0; r < G; r++) {
        gi[t * G + r] = bih[r] + dot(Wih, r * inDim, x, t * inDim, inDim);
      }
    let h = new Float32Array(H); const gh = new Float64Array(G);
    for (let step = 0; step < T; step++) {
      const t = reverse ? T - 1 - step : step;
      for (let r = 0; r < G; r++) gh[r] = bhh[r] + dot(Whh, r * H, h, 0, H);
      const nh = new Float32Array(H), base = t * G;
      for (let j = 0; j < H; j++) {
        const rg = sigmoid(gi[base + j] + gh[j]);                 // PyTorch gate order: r, z, n
        const zg = sigmoid(gi[base + H + j] + gh[H + j]);
        const ng = Math.tanh(gi[base + 2 * H + j] + rg * gh[2 * H + j]);
        nh[j] = (1 - zg) * ng + zg * h[j];
        out[t * 2 * H + col + j] = nh[j];
      }
      h = nh;
    }
  }

  class SignRecognizer {
    static async load(dir) {
      const cfg = await (await fetch(`${dir}/sign_model.json`)).json();
      const buf = await (await fetch(`${dir}/sign_gru.bin`)).arrayBuffer();
      return new SignRecognizer(cfg, buf);
    }
    constructor(cfg, buf) {
      this.cfg = cfg; this.w = {};
      for (const [k, v] of Object.entries(cfg.tensors))
        this.w[k] = new Float32Array(buf, v.offset * 4, v.shape.reduce((a, b) => a * b, 1));
      this.classes = cfg.classes; this.id2bn = cfg.id2bn || {};
    }
    // frames: array of Float32Array(225) = 75 points x (x,y,z), raw MediaPipe coordinates, 0 = not detected
    featurize(frames) {
      if (this.cfg.fill_missing) frames = fillMissing(frames);       // v3 models: interpolate lost hands
      const s = resampleT(normalizeSeq(frames, this.cfg.rot_norm), this.cfg.t_fixed);
      return features(s, this.cfg);
    }
    forward(feat) {
      const cfg = this.cfg, w = this.w, T = cfg.t_fixed, F = cfg.feat, H = cfg.hidden;
      let x = new Float32Array(T * F); const tmp = new Float32Array(F);
      for (let t = 0; t < T; t++) x.set(layerNorm(feat.subarray(t * F, (t + 1) * F), F, w["inorm.weight"], w["inorm.bias"], tmp), t * F);
      let inDim = F;
      for (let l = 0; l < cfg.layers; l++) {
        const out = new Float32Array(T * 2 * H);
        for (const [sfx, rev, col] of [["", false, 0], ["_reverse", true, H]])
          gruDir(x, T, inDim, w[`gru.weight_ih_l${l}${sfx}`], w[`gru.weight_hh_l${l}${sfx}`],
                 w[`gru.bias_ih_l${l}${sfx}`], w[`gru.bias_hh_l${l}${sfx}`], H, rev, out, col);
        x = out; inDim = 2 * H;
      }
      const pooled = new Float64Array(inDim);                     // mean over time
      for (let t = 0; t < T; t++) for (let i = 0; i < inDim; i++) pooled[i] += x[t * inDim + i] / T;
      const y = layerNorm(pooled, inDim, w["head.0.weight"], w["head.0.bias"], new Float64Array(inDim));
      const Wo = w["head.2.weight"], bo = w["head.2.bias"], C = bo.length, logits = new Float64Array(C);
      for (let c = 0; c < C; c++) { let s = bo[c]; for (let i = 0; i < inDim; i++) s += Wo[c * inDim + i] * y[i]; logits[c] = s; }
      return logits;
    }
    // returns [{id:"W1", word:"বাবা", p:0.83}, ...] best first
    classify(frames, k = 3) {
      const logits = this.forward(this.featurize(frames));
      const mx = Math.max(...logits), e = logits.map(v => Math.exp(v - mx)), sum = e.reduce((a, b) => a + b, 0);
      return [...e].map((v, i) => ({ id: this.classes[i], word: this.id2bn[this.classes[i]] || this.classes[i], p: v / sum }))
                   .sort((a, b) => b.p - a.p).slice(0, k);
    }
  }

  SignRecognizer.POSE_N = POSE_N; SignRecognizer.LH_N = LH_N; SignRecognizer.N_PTS = N_PTS;
  root.SignRecognizer = SignRecognizer;
  if (typeof module !== "undefined") module.exports = SignRecognizer;
})(typeof window !== "undefined" ? window : globalThis);
