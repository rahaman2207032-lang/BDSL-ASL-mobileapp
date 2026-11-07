r"""
make_space.py - builds a clean ..\hf-space folder to upload to a FREE Hugging Face Space (Gradio SDK).
Run inside english-server:   python make_space.py
"""
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "hf-space"

README = """---
title: BdSL English Engine
emoji: 🤟
colorFrom: indigo
colorTo: green
sdk: gradio
sdk_version: 5.16.1
app_file: app.py
pinned: false
---
English engine for the BdSL app (Motion-S text -> sign, ASL sign -> word).
"""
REQS = """torch
numpy
transformers>=4.46
safetensors
ai-edge-litert
"""

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir()
for f in ("app.py", "server.py", "motion_s.py", "skeleton.py", "asl.py"):
    shutil.copy2(HERE / f, OUT / f)
skip = shutil.ignore_patterns("__pycache__", "*.pyc", "PUT_YOUR_KAGGLE_FILES_HERE.txt")
for d in ("asl", "models_en"):
    shutil.copytree(HERE / d, OUT / d, ignore=skip)
(OUT / "README.md").write_text(README, encoding="utf-8")
(OUT / "requirements.txt").write_text(REQS, encoding="utf-8")

import sys
sys.path.insert(0, str(HERE))
import motion_s
miss = motion_s.missing_files()
if not (HERE / "asl" / "asl_model.tflite").is_file():
    miss.append("asl/asl_model.tflite (run tools\\add_english.js first)")
size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file()) / 1e6
print(f"Created {OUT}  ({size:.0f} MB)")
print("WARNING - still missing: " + "; ".join(miss) if miss else "All model files found. Ready to upload.")
