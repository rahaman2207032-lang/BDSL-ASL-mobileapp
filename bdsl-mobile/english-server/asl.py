"""
asl.py - your English (ASL) sign -> word model, same as sign_live.py "asl" mode:
asl_model.tflite (6th place, Google Isolated Sign Language Recognition, Theo Viel & Christof Henkel, MIT licence),
250 words, input = one sign as [frames, 543, 3] MediaPipe Holistic landmarks with NaN where nothing was detected:
    0-467 face | 468-488 left hand | 489-521 pose | 522-542 right hand
Copy asl_model.tflite from  "English sign to word/sign_live/sign_live/"  into  english-server/asl/.
"""
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent / "asl"
MODEL, LABELS = HERE / "asl_model.tflite", HERE / "asl_labels.json"


def _interpreter(path):
    for mod in ("ai_edge_litert.interpreter", "tflite_runtime.interpreter", "tensorflow.lite"):
        try:
            m = __import__(mod, fromlist=["Interpreter"])
            return m.Interpreter(model_path=str(path))
        except ImportError:
            continue
    raise ImportError("No TFLite runtime. Run:  pip install ai-edge-litert   (on Windows if that fails:  pip install tensorflow)")


class ASLModel:
    def __init__(self):
        if not MODEL.is_file():
            raise FileNotFoundError(f"Missing {MODEL} - copy asl_model.tflite from your repo's sign_live folder")
        self.run = _interpreter(MODEL).get_signature_runner("serving_default")
        idx = json.loads(LABELS.read_text(encoding="utf-8"))
        self.labels = [w for w, _ in sorted(idx.items(), key=lambda kv: kv[1])]

    def predict(self, seq, k=5):
        """seq: [T, 543, 3] float32 (NaN = missing) -> [{word, p}, ...] best first"""
        seq = np.asarray(seq, dtype=np.float32)
        out = np.asarray(self.run(inputs=seq)["outputs"]).reshape(-1)
        if out.min() < 0 or out.sum() > 1.5:                    # logits -> probabilities
            e = np.exp(out - out.max()); out = e / e.sum()
        order = np.argsort(-out)[:k]
        return [{"word": self.labels[i], "p": float(out[i])} for i in order]
