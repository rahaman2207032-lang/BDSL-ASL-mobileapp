"""
asl.py - your English (ASL) sign -> word model, same as sign_live.py "asl" mode:
asl_model.tflite (6th place, Google Isolated Sign Language Recognition, Theo Viel & Christof Henkel, MIT licence),
250 words, input = one sign as [frames, 543, 3] MediaPipe Holistic landmarks with NaN where nothing was detected:
    0-467 face | 468-488 left hand | 489-521 pose | 522-542 right hand
Copy asl_model.tflite from  "English sign to word/sign_live/sign_live/"  into  english-server/asl/.

Robustness (v3):
  * Every sign is first given to the model EXACTLY as recorded (same as sign_live.py).
  * Only if TFLite fails (e.g. "XNNPack delegate failed to reshape ..." on some short phone recordings) the
    interpreter is rebuilt and the sign retried without XNNPack, then once more stretched to MIN_T frames.
  * One prediction at a time (a TFLite interpreter is not thread-safe).
"""
import json
import threading
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent / "asl"
MODEL, LABELS = HERE / "asl_model.tflite", HERE / "asl_labels.json"
MIN_T, MAX_T = 32, 384          # frames: shorter signs are stretched, longer ones thinned out


def _interpreter(path, plain=False):
    for mod in ("ai_edge_litert.interpreter", "tflite_runtime.interpreter", "tensorflow.lite"):
        try:
            m = __import__(mod, fromlist=["Interpreter"])
        except ImportError:
            continue
        resolver = getattr(m, "OpResolverType", None) or getattr(getattr(m, "experimental", None), "OpResolverType", None)
        if plain and resolver is not None:
            try:                 # no XNNPack delegate
                return m.Interpreter(model_path=str(path),
                                     experimental_op_resolver_type=resolver.BUILTIN_WITHOUT_DEFAULT_DELEGATES)
            except Exception:
                pass
        return m.Interpreter(model_path=str(path))
    raise ImportError("No TFLite runtime. Run:  pip install ai-edge-litert   (on Windows if that fails:  pip install tensorflow)")


def _resample(seq, n):
    """Pick n frames spread evenly over the sign (keeps NaN = missing exactly as recorded)."""
    idx = np.round(np.linspace(0, len(seq) - 1, n)).astype(int)
    return seq[idx]


class ASLModel:
    def __init__(self):
        if not MODEL.is_file():
            raise FileNotFoundError(f"Missing {MODEL} - copy asl_model.tflite from your repo's sign_live folder")
        idx = json.loads(LABELS.read_text(encoding="utf-8"))
        self.labels = [w for w, _ in sorted(idx.items(), key=lambda kv: kv[1])]
        self.lock = threading.Lock()
        self._build()

    def _build(self, plain=False):
        self.run = _interpreter(MODEL, plain).get_signature_runner("serving_default")

    def _predict(self, seq):
        return np.asarray(self.run(inputs=seq)["outputs"]).reshape(-1)

    def predict(self, seq, k=5):
        """seq: [T, 543, 3] float32 (NaN = missing) -> [{word, p}, ...] best first"""
        seq = np.asarray(seq, dtype=np.float32)
        if len(seq) == 0:
            raise ValueError("no frames")
        if len(seq) > MAX_T:
            seq = _resample(seq, MAX_T)
        with self.lock:
            try:
                out = self._predict(seq)                          # as recorded
            except Exception:
                self._build(plain=True)                           # a failed interpreter stays broken: rebuild
                try:
                    out = self._predict(seq)                      # same frames, no XNNPack
                except Exception:
                    self._build(plain=True)
                    out = self._predict(_resample(seq, max(len(seq), MIN_T)))   # last resort: stretched
                finally:
                    try: self._build()                            # back to the normal interpreter for the next sign
                    except Exception: pass
        if out.min() < 0 or out.sum() > 1.5:                    # logits -> probabilities
            e = np.exp(out - out.max()); out = e / e.sum()
        order = np.argsort(-out)[:k]
        return [{"word": self.labels[i], "p": float(out[i])} for i in order]
