"""
build_pack.py  -  turns the RAW pose files (bdsl-mediapipe-final) into a small "pack"
that the website/app can play.

Input : folder holding the raw .npy files (it searches all sub-folders),
        each file shaped (frames, 543, 3) and named  <sentenceID>_<signer>.npy
        + Bangla_Sign_Sentence.xlsx  (sheet "Training Data")
Output: <out>/manifest.json  and  <out>/poses/<sentenceID>.bsl
"""
import json, re, struct, sys, unicodedata
from pathlib import Path
import numpy as np, pandas as pd
from scipy.signal import savgol_filter

FPS = 30            # playback speed. If signs look too fast/slow, change and re-run.
CLIP = 4.0          # coordinates are stored in "shoulder widths", clipped to +-4

# Points we keep (51): 0 nose | 1 L-shoulder 2 R-shoulder | 3 L-elbow 4 R-elbow
#                      5 L-wrist 6 R-wrist | 7 L-hip 8 R-hip | 9..29 left hand | 30..50 right hand
KEEP = [0, 11, 12, 13, 14, 15, 16, 23, 24] + list(range(33, 75))


def norm_text(s):
    s = unicodedata.normalize("NFC", str(s))
    s = re.sub(r"[।,.?!\"'‘’“”:;()\-–]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def hand_coverage(a):
    """Share of frames where BOTH hands were detected (used to pick the best signer)."""
    lh, rh = a[:, 33:54], a[:, 54:75]
    ok = (np.nan_to_num(np.abs(lh)).sum((1, 2)) > 1e-6) & (np.nan_to_num(np.abs(rh)).sum((1, 2)) > 1e-6)
    return float(ok.mean())


def clean(a):
    """Keep 51 points, fill missing frames, smooth."""
    a = a[:, KEEP, :].astype(np.float32)
    bad = ~np.isfinite(a).all(-1) | (np.abs(a).sum(-1) < 1e-6)
    a[bad] = np.nan
    t = np.arange(len(a))
    for p in range(a.shape[1]):
        for c in range(3):
            y = a[:, p, c]
            ok = np.isfinite(y)
            a[:, p, c] = np.interp(t, t[ok], y[ok]) if ok.any() else 0.0
    w = min(9, (len(a) // 2) * 2 - 1)
    if w >= 5:
        a = savgol_filter(a, w, 2, axis=0)
    return a


def normalise(a):
    """Centre on the shoulders and measure everything in shoulder-widths."""
    ls, rs = a[:, 1], a[:, 2]
    centre = np.median((ls + rs) / 2, axis=0)
    width = np.median(np.linalg.norm((ls - rs)[:, :2], axis=1))
    return (a - centre) / max(width, 1e-6)


def pack(a, fps):
    q = np.round(np.clip(a, -CLIP, CLIP) / CLIP * 32767).astype("<i2")
    return b"BSL1" + struct.pack("<HHBx", len(q), q.shape[1], fps) + q.tobytes()


def main(pose_root, xlsx, out_dir, fps=FPS):
    out = Path(out_dir)
    (out / "poses").mkdir(parents=True, exist_ok=True)

    df = pd.read_excel(xlsx, sheet_name="Training Data")
    df = df.iloc[:, :3]
    df.columns = ["id", "text", "gloss"]
    df["id"] = df["id"].astype(str).str.replace(r"\.0$", "", regex=True)
    print("sentences in xlsx:", len(df))

    files = {}
    for p in Path(pose_root).rglob("*.npy"):
        if "_" not in p.stem:
            continue
        sid, signer = p.stem.rsplit("_", 1)
        files.setdefault(sid, []).append(p)
    print("pose files found:", sum(len(v) for v in files.values()), "| distinct sentence ids:", len(files))
    if not files:
        raise SystemExit("No .npy files found - check the pose_root path.")
    print("example file names:", [p.name for v in list(files.values())[:3] for p in v[:2]])

    manifest, missing = [], 0
    for r in df.itertuples():
        cands = files.get(r.id, [])
        if not cands:
            missing += 1
            continue
        best = max(cands, key=lambda p: hand_coverage(np.load(p, mmap_mode="r")))
        a = normalise(clean(np.load(best)))
        (out / "poses" / f"{r.id}.bsl").write_bytes(pack(a, fps))
        manifest.append({"id": r.id, "text": str(r.text), "norm": norm_text(r.text),
                         "gloss": str(r.gloss), "frames": len(a), "signer": best.stem.rsplit("_", 1)[1]})
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    print(f"DONE: packed {len(manifest)} sentences ({missing} xlsx rows had no pose file)")


# runs only from a terminal (python build_pack.py <poses> <xlsx> <out>), never inside a notebook
if __name__ == "__main__" and "ipykernel" not in sys.modules and len(sys.argv) >= 4:
    main(sys.argv[1], sys.argv[2], sys.argv[3])
