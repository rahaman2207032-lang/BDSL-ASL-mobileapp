"""
verify_against_pytorch.py - proves the app's JavaScript model gives the same answers as YOUR PyTorch model.

    Step 1 (PyTorch, your webcam-script setup):
        python tools/verify_against_pytorch.py  word_gru.pt  config.json
    Step 2 (the app's JavaScript):
        node tools/verify_js.js

Step 1 builds 20 test clips, runs them through the GRUClassifier + feature functions copied from
bdsl_word_model/sign_to_word_webcam.py (unchanged), and saves the answers to tools/verify_cases.json.
Step 2 runs the same clips through www/recognize.js + www/models/sign and compares.
"""
import json, os, sys
import numpy as np
import torch, torch.nn as nn

PT, CFG_PATH = sys.argv[1], sys.argv[2]
CFG = json.load(open(CFG_PATH, encoding="utf-8"))
CLASSES = CFG["classes"]; FEAT = CFG["feat"]; N_PTS = CFG["n_pts"]; T_FIXED = CFG["t_fixed"]
POSE_N, LH_N, RH_N = CFG["pose_n"], CFG["lh_n"], CFG["rh_n"]; L_SH, R_SH = CFG["l_sh"], CFG["r_sh"]
USE_VELOCITY = CFG.get("use_velocity", False); ROT_NORM = CFG.get("rot_norm", False); HAND_LOCAL = CFG.get("hand_local", False)
FILL_MISSING = CFG.get("fill_missing", False)   # v3 models (Notebook 2 v3)

# ---------------- copied unchanged from sign_to_word_webcam.py ----------------
class GRUClassifier(nn.Module):
    def __init__(self, feat=FEAT, hid=256, n_cls=len(CLASSES), p=0.3):
        super().__init__()
        self.inorm = nn.LayerNorm(feat)
        self.gru = nn.GRU(feat, hid, 2, batch_first=True, bidirectional=True, dropout=p)
        self.head = nn.Sequential(nn.LayerNorm(hid*2), nn.Dropout(p), nn.Linear(hid*2, n_cls))
    def forward(self, x):
        o, _ = self.gru(self.inorm(x))
        return self.head(o.mean(1))

def normalize_seq(seq):
    out = seq.copy().astype(np.float32)
    for t in range(out.shape[0]):
        ls, rs = out[t, L_SH], out[t, R_SH]
        if np.all(ls == 0) or np.all(rs == 0): continue
        neck = (ls + rs) / 2.0
        sd_ = np.linalg.norm(ls - rs) or 1.0
        m = ~np.all(out[t] == 0, axis=1)
        out[t][m] = (out[t][m] - neck) / sd_
        if ROT_NORM:
            v = out[t, R_SH] - out[t, L_SH]
            ang = np.arctan2(v[1], v[0])
            c, s = np.cos(-ang), np.sin(-ang)
            xy = out[t][m][:, :2]
            out[t][m] = np.concatenate(
                [np.stack([xy[:, 0]*c - xy[:, 1]*s, xy[:, 0]*s + xy[:, 1]*c], 1),
                 out[t][m][:, 2:]], axis=1)
    return out

def resample_T(seq, T=T_FIXED):
    T0 = seq.shape[0]
    if T0 == 0: return np.zeros((T, N_PTS, 3), np.float32)
    if T0 == T: return seq.astype(np.float32)
    idx = np.linspace(0, T0 - 1, T)
    lo = np.floor(idx).astype(int); hi = np.minimum(lo + 1, T0 - 1)
    fr = (idx - lo)[:, None, None]
    return (seq[lo]*(1-fr) + seq[hi]*fr).astype(np.float32)

def hand_local(seq):
    T = seq.shape[0]
    out = np.zeros((T, LH_N + RH_N, 3), np.float32)
    for bi, off in enumerate((POSE_N, POSE_N + LH_N)):
        blk = seq[:, off:off+LH_N, :]
        wrist = blk[:, 0:1, :]
        span = np.linalg.norm(blk[:, 9, :] - blk[:, 0, :], axis=1)
        ok = (~np.all(blk == 0, axis=(1, 2))) & (span > 1e-6)
        sc = np.where(span > 1e-6, span, 1.0)[:, None, None]
        loc = (blk - wrist) / sc
        out[ok, bi*LH_N:(bi+1)*LH_N, :] = loc[ok]
    return out

def to_features(seq):
    f = seq.reshape(seq.shape[0], N_PTS*3)
    if USE_VELOCITY:
        d = np.diff(f, axis=0, prepend=f[:1]); f = np.concatenate([f, d], axis=1)
    if HAND_LOCAL:
        f = np.concatenate([f, hand_local(seq).reshape(seq.shape[0], -1)], axis=1)
    return f.astype(np.float32)

def fill_missing(seq):                 # copied from Notebook 2 v3
    out = seq.copy(); T = out.shape[0]; t = np.arange(T)
    for a, b in ((0, POSE_N), (POSE_N, POSE_N + LH_N), (POSE_N + LH_N, N_PTS)):
        present = ~np.all(out[:, a:b] == 0, axis=(1, 2))
        if present.all() or not present.any(): continue
        for p in range(a, b):
            for c in range(3):
                out[:, p, c] = np.interp(t, t[present], out[present, p, c])
    return out
# -------------------------------------------------------------------------------

model = GRUClassifier(); model.load_state_dict(torch.load(PT, map_location="cpu")); model.eval()

rng = np.random.default_rng(7)
def clip(T):                          # a person-shaped skeleton with moving hands, some frames missing a hand
    base = np.zeros((N_PTS, 3), np.float32)
    base[:33, 0] = rng.uniform(.35, .65, 33); base[:33, 1] = rng.uniform(.2, .9, 33)
    base[11] = [.62, .45, -.1]; base[12] = [.38, .46, -.12]
    lh = np.array([.65, .55, 0]) + rng.normal(0, .03, (21, 3)); rh = np.array([.35, .55, 0]) + rng.normal(0, .03, (21, 3))
    a, b = rng.uniform(3, 9), rng.uniform(3, 9); out = []
    for t in range(T):
        f = base + rng.normal(0, .004, base.shape); d = np.array([np.sin(t/a)*.1, np.cos(t/b)*.08, 0])
        f[33:54] = lh + d; f[54:75] = rh - d * rng.uniform(.3, 1.2)
        if rng.random() < .15: f[33:54] = 0
        if rng.random() < .15: f[54:75] = 0
        out.append(f.astype(np.float32))
    return np.array(out)

cases = []
for T in rng.integers(6, 140, 20):
    seq = clip(int(T))
    with torch.no_grad():
        p = torch.softmax(model(torch.from_numpy(to_features(resample_T(normalize_seq(fill_missing(seq) if FILL_MISSING else seq)))[None])), 1)[0].numpy()
    cases.append({"frames": seq.reshape(len(seq), -1).tolist(), "probs": p.tolist(), "top": CLASSES[int(p.argmax())]})
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify_cases.json")
json.dump(cases, open(out, "w"))
print(f"PyTorch answers for {len(cases)} clips saved to {out} (pipeline v{CFG.get('pipeline_version', 2)}, fill_missing={FILL_MISSING})\nNow run:  node tools/verify_js.js")
