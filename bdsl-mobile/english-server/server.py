"""
server.py - the "English engine" for the BdSL app. Runs on your PC; phones on the SAME Wi-Fi use it.

    POST /api/en/text2sign   {"text": "Where are you going?"}
         -> {"gloss": "...", "frames": T, "fps": 24, "pose": "<base64 .bsl>", "ms": 1234}
         (your Motion-S generative model, converted to the app's avatar format)
    POST /api/en/sign2word   body = float32 [T, 543, 3] (MediaPipe Holistic, NaN = missing), header X-Frames: T
         -> {"top": [{"word": "dog", "p": 0.91}, ...]}        (your asl_model.tflite)
    GET  /health              -> what is loaded

Run:   python server.py            (default port 8765;  --port 9000  to change)
Only Python's standard library is used for the web part.
"""
import argparse
import base64
import json
import socket
import sys
import threading
import time
import traceback
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

import skeleton

STATE = {"text2sign": "not loaded", "sign2word": "not loaded"}
ENGINES = {"motion": None, "asl": None}
CACHE = OrderedDict()                     # text -> result (generation takes a few seconds on CPU)
GEN_LOCK = threading.Lock()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_engines(device):
    try:
        import motion_s
        miss = motion_s.missing_files()
        if miss:
            STATE["text2sign"] = "missing files in models_en: " + "; ".join(miss)
        else:
            STATE["text2sign"] = "loading"
            log("Loading English text -> sign model (Motion-S)…")
            ENGINES["motion"] = motion_s.MotionS(device=device, log=log)
            STATE["text2sign"] = "ready"
            log("text -> sign: READY")
    except Exception as e:
        STATE["text2sign"] = "error: " + str(e)
        traceback.print_exc()
    try:
        import asl
        STATE["sign2word"] = "loading"
        ENGINES["asl"] = asl.ASLModel()
        STATE["sign2word"] = f"ready ({len(ENGINES['asl'].labels)} words)"
        log("sign -> word:", STATE["sign2word"])
    except Exception as e:
        STATE["sign2word"] = "error: " + str(e)
        log("sign -> word NOT available:", e)


def text2sign(text):
    key = " ".join(str(text).lower().split())
    if key in CACHE:
        CACHE.move_to_end(key); return CACHE[key]
    eng = ENGINES["motion"]
    if eng is None:
        raise RuntimeError("text -> sign model is " + STATE["text2sign"])
    t0 = time.time()
    with GEN_LOCK:                        # one generation at a time (CPU)
        out = eng.generate(text)
    bsl, pts = skeleton.features_to_bsl(out["motion"])
    res = {"text": text, "gloss": out["gloss"], "length": int(out["length"]), "frames": int(pts.shape[0]),
           "fps": skeleton.FPS, "pose": base64.b64encode(bsl).decode("ascii"), "ms": int((time.time() - t0) * 1000)}
    CACHE[key] = res
    if len(CACHE) > 300: CACHE.popitem(last=False)
    log(f"text2sign  '{text}' -> {out['gloss']}  ({res['frames']} frames, {res['ms']} ms)")
    return res


def sign2word(raw, frames):
    eng = ENGINES["asl"]
    if eng is None:
        raise RuntimeError("sign -> word model is " + STATE["sign2word"])
    a = np.frombuffer(raw, dtype="<f4")
    if frames <= 0 or a.size != frames * 543 * 3:
        raise ValueError(f"expected {frames} x 543 x 3 floats, got {a.size}")
    top = eng.predict(a.reshape(frames, 543, 3))
    log(f"sign2word  {frames} frames -> " + ", ".join(f"{t['word']} {t['p']:.0%}" for t in top[:3]))
    return {"top": top}


class Handler(BaseHTTPRequestHandler):
    server_version = "BdSLEnglish/1.0"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors(); self.end_headers(); self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Frames")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/health"):
            return self._send(200, {"ok": True, "text2sign": STATE["text2sign"], "sign2word": STATE["sign2word"],
                                    "fps": skeleton.FPS, "version": 1})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 20_000_000: return self._send(413, {"error": "too large"})
            raw = self.rfile.read(n)
            if path == "/api/en/text2sign":
                text = str(json.loads(raw.decode("utf-8") or "{}").get("text", "")).strip()[:300]
                if not text: return self._send(400, {"error": "empty text"})
                return self._send(200, text2sign(text))
            if path == "/api/en/sign2word":
                return self._send(200, sign2word(raw, int(self.headers.get("X-Frames") or 0)))
            self._send(404, {"error": "not found"})
        except (ValueError, json.JSONDecodeError) as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc(); self._send(500, {"error": str(e)})

    def log_message(self, *a):            # quiet: our own log() lines are enough
        pass


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("10.255.255.255", 1)); ips.add(s.getsockname()[0]); s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET): ips.add(info[4][0])
    except Exception:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main():
    ap = argparse.ArgumentParser(description="English engine for the BdSL app")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", default="cpu", help="cpu or cuda")
    args = ap.parse_args()
    threading.Thread(target=load_engines, args=(args.device,), daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print("\n  English engine running. In the app (English mode -> Engine) enter ONE of these addresses:")
    for ip in lan_ips(): print(f"     {ip}:{args.port}")
    print(f"     localhost:{args.port}   (only for the app opened on this PC)\n"
          "  Phones must be on the SAME Wi-Fi. If Windows asks about the firewall, click Allow.\n  Ctrl+C to stop.\n", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("bye")


if __name__ == "__main__":
    sys.exit(main())
