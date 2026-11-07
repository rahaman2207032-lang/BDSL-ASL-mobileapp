"""
motion_s.py - your English text -> sign GENERATIVE model (Motion-S), unchanged from motion_s_final_end_to_end_demo.py:

    English sentence -> Phase-3 T5 (text -> gloss, beam 4)
                     -> Phase-6 length head (gloss -> number of motion tokens T)
                     -> Phase-8 DYNAMICS generator (gloss + T -> RVQ tokens [6, T])
                     -> official Motion-S RVQ decoder (tokens -> motion [4T, 668])

Put the trained files anywhere inside  models_en/  (sub-folders are fine). Needed:
    model.safetensors (or pytorch_model.bin) + config.json      Phase-3  best_model/
    tokenizer.json + tokenizer_config.json                       Phase-3  tokenizer/
    best_model.pt                                                Phase-6  length_model/
    best_motion_generator.pt                                     Phase-8  final_model/
    rvq_vae_best.pth                                             Kaggle model antonygithinji/motion-s-vae-rvq
    motion_mean_668.npy, motion_std_668.npy                      Phase-5b diagnostics/
The two small config files (generator architecture, length calibration) are already in models_en/configs/.
"""
import json
import re
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

PAD_ID, BOS_ID, EOS_ID = 512, 513, 514
HERE = Path(__file__).resolve().parent
ROOT = HERE / "models_en"


def _find(name, prefer=None):
    hits = sorted((p for p in ROOT.rglob(name) if p.is_file()), key=lambda p: (0 if prefer and prefer in p.as_posix().lower() else 1, len(p.parts)))
    return hits[0] if hits else None


def missing_files():
    """Names of required files that are not in models_en/ yet (empty list = ready)."""
    need = {"Phase-3 model weights (model.safetensors or pytorch_model.bin)": _phase3_dir() is None,
            "Phase-3 tokenizer (tokenizer.json)": _find("tokenizer.json") is None,
            "Phase-6 length model (best_model.pt)": _find("best_model.pt", "length") is None,
            "Phase-8 generator (best_motion_generator.pt)": _find("best_motion_generator.pt") is None,
            "RVQ decoder (rvq_vae_best.pth)": _find("rvq_vae_best.pth") is None,
            "motion_mean_668.npy": _find("motion_mean_668.npy") is None,
            "motion_std_668.npy": _find("motion_std_668.npy") is None}
    return [k for k, miss in need.items() if miss]


def _phase3_dir():
    for cfg in sorted(ROOT.rglob("config.json"), key=lambda p: len(p.parts)):
        d = cfg.parent
        if not ((d / "model.safetensors").is_file() or (d / "pytorch_model.bin").is_file()):
            continue
        try:
            if "T5ForConditionalGeneration" in json.loads(cfg.read_text(encoding="utf-8")).get("architectures", []):
                return d
        except Exception:
            pass
    return None


class MotionS:
    def __init__(self, device="cpu", log=print):
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        miss = missing_files()
        if miss:
            raise FileNotFoundError("models_en/ is missing: " + "; ".join(miss))
        self.device = torch.device(device)
        dev = self.device

        phase3 = _phase3_dir()
        tok_dir = (_find("tokenizer.json", "tokenizer") or _find("tokenizer.json")).parent
        log(f"  Phase-3 model:  {phase3}\n  tokenizer:      {tok_dir}")
        self.tokenizer = AutoTokenizer.from_pretrained(str(tok_dir), local_files_only=True, use_fast=True)
        self.phase3 = AutoModelForSeq2SeqLM.from_pretrained(str(phase3), local_files_only=True).to(dev).eval()
        for p in self.phase3.parameters(): p.requires_grad = False
        enc = self.phase3.get_encoder()
        rep = _find("phase3_report.json") or _find("evaluation_metrics.json")
        sel = json.loads(rep.read_text(encoding="utf-8")).get("selected_decoding") if rep else "beam_4"
        self.beams = 4 if (sel or "beam_4") == "beam_4" else 1

        mc = json.loads((_find("model_config.json", "configs") or _find("model_config.json")).read_text(encoding="utf-8"))
        lc_path = _find("length_config.json") or (_find("best_model.pt", "length").parent / "config.json")
        lc = json.loads(lc_path.read_text(encoding="utf-8"))
        self.bounds = list(map(int, lc["training_bounds"]))
        self.calib = lc["calibration"]

        # ---- Phase-4/7/8 generator (architecture copied exactly from the final demo notebook) ----
        class MotionModel(nn.Module):
            def __init__(self, encoder):
                super().__init__(); self.gloss_encoder = encoder
                d_model, d_level = int(mc["d_model"]), int(mc["d_level"])
                self.encoder_projection = nn.Linear(int(encoder.config.d_model), d_model)
                self.level_embeddings = nn.ModuleList([nn.Embedding(515, d_level, padding_idx=PAD_ID) for _ in range(6)])
                self.motion_projection = nn.Linear(6 * d_level, d_model)
                self.temporal_positions = nn.Embedding(int(mc["max_model_positions"]), d_model)
                layer = nn.TransformerDecoderLayer(d_model, int(mc["num_heads"]), int(mc["ffn_dimension"]), float(mc["dropout"]),
                                                   activation="gelu", batch_first=True, norm_first=True)
                self.decoder = nn.TransformerDecoder(layer, int(mc["decoder_layers"]), norm=nn.LayerNorm(d_model))
                self.heads = nn.ModuleList([nn.Linear(d_model, 515) for _ in range(6)])

            def encode(self, ids, mask):
                return self.encoder_projection(self.gloss_encoder(input_ids=ids, attention_mask=mask).last_hidden_state)

            def decode(self, tokens, memory, mask, padding):
                emb = torch.cat([self.level_embeddings[q](tokens[:, q]) for q in range(6)], -1)
                emb = self.motion_projection(emb) + self.temporal_positions(torch.arange(tokens.shape[-1], device=tokens.device)[None])
                causal = torch.triu(torch.ones(tokens.shape[-1], tokens.shape[-1], dtype=torch.bool, device=tokens.device), 1)
                h = self.decoder(emb, memory, tgt_mask=causal, tgt_key_padding_mask=padding, memory_key_padding_mask=~mask.bool())
                return torch.stack([head(h) for head in self.heads], 1)

        self.gen = MotionModel(enc).to(dev)
        payload = torch.load(_find("best_motion_generator.pt"), map_location="cpu", weights_only=True)
        res = self.gen.load_state_dict(payload.get("motion_state_dict", payload), strict=False)
        bad = [k for k in res.missing_keys if not k.startswith("gloss_encoder.")]
        if bad or res.unexpected_keys:
            raise RuntimeError(f"generator checkpoint does not match the architecture: missing={bad[:5]} unexpected={res.unexpected_keys[:5]}")
        self.gen.eval()

        class LengthHead(nn.Module):
            def __init__(self):
                super().__init__(); d = int(enc.config.d_model)
                self.network = nn.Sequential(nn.Linear(d, 256), nn.GELU(), nn.Dropout(.1), nn.Linear(256, 1))

            def forward(self, v): return self.network(v).squeeze(-1)

        self.length_head = LengthHead().to(dev)
        lp = torch.load(_find("best_model.pt", "length"), map_location="cpu", weights_only=True)
        self.length_head.load_state_dict(lp["length_head_state_dict"], strict=True)
        self.length_head.eval()

        class MotionDecoder(nn.Module):
            def __init__(self):
                super().__init__()
                self.decoder = nn.Sequential(
                    nn.ConvTranspose1d(256, 512, 3, 2, 1, output_padding=1), nn.ReLU(), nn.BatchNorm1d(512),
                    nn.ConvTranspose1d(512, 512, 3, 2, 1, output_padding=1), nn.ReLU(), nn.BatchNorm1d(512),
                    nn.ConvTranspose1d(512, 512, 3, 1, 1), nn.ReLU(), nn.BatchNorm1d(512),
                    nn.ConvTranspose1d(512, 668, 3, 1, 1))

            def forward(self, v): return self.decoder(v)

        rvq = torch.load(_find("rvq_vae_best.pth"), map_location="cpu", weights_only=True)
        for key in ("model_state_dict", "state_dict"):
            if isinstance(rvq, dict) and key in rvq: rvq = rvq[key]; break
        rvq = {k: v for k, v in rvq.items() if isinstance(v, torch.Tensor)}
        self.decoder = MotionDecoder()
        self.decoder.load_state_dict({k[8:]: v for k, v in rvq.items() if k.startswith("decoder.")}, strict=True)
        self.decoder = self.decoder.to(dev).eval()
        self.codebooks = torch.stack([rvq[f"rvq.quantizers.{lv}.embedding"].float() for lv in range(6)]).to(dev)
        mean = np.load(_find("motion_mean_668.npy")).astype(np.float32)
        std = np.load(_find("motion_std_668.npy")).astype(np.float32); std[std < 1e-6] = 1.0
        self.mean, self.std = torch.from_numpy(mean).to(dev), torch.from_numpy(std).to(dev)

    # ---------------- the four steps (same code as the notebook) ----------------
    @torch.inference_mode()
    def text_to_gloss(self, text):
        cleaned = re.sub(r"\s+", " ", str(text)).strip()
        if not cleaned: raise ValueError("English text must not be empty")
        enc = self.tokenizer("text to gloss: " + cleaned, truncation=True, max_length=128, return_tensors="pt").to(self.device)
        out = self.phase3.generate(**enc, max_length=128, num_beams=self.beams, do_sample=False, early_stopping=self.beams > 1)
        gloss = re.sub(r"\s+", " ", self.tokenizer.decode(out[0], skip_special_tokens=True)).strip()
        if not gloss: raise RuntimeError("Phase-3 returned an empty gloss")
        return gloss

    @torch.inference_mode()
    def predict_length(self, gloss):
        enc = self.tokenizer([gloss], padding=True, truncation=False, return_tensors="pt")
        ids, mask = enc["input_ids"].to(self.device), enc["attention_mask"].to(self.device)
        h = self.phase3.get_encoder()(input_ids=ids, attention_mask=mask).last_hidden_state.float()
        pooled = (h * mask[:, :, None]).sum(1) / mask.sum(1, keepdim=True).clamp_min(1)
        v = torch.expm1(self.length_head(pooled)).cpu().numpy()
        if self.calib.get("selected"): v = float(self.calib["slope"]) * v + float(self.calib["intercept"])
        return int(np.clip(np.rint(v), self.bounds[0], self.bounds[1])[0])

    @torch.inference_mode()
    def generate_tokens(self, gloss, length):
        enc = self.tokenizer([gloss], padding=True, truncation=False, return_tensors="pt")
        ids, mask = enc["input_ids"].to(self.device), enc["attention_mask"].to(self.device)
        memory = self.gen.encode(ids, mask)
        hist = torch.full((1, 6, 1), BOS_ID, dtype=torch.long, device=self.device)
        pad = torch.zeros((1, 1), dtype=torch.bool, device=self.device)
        steps = []
        for _ in range(int(length)):
            choice = self.gen.decode(hist, memory, mask, pad)[:, :, -1, :512].argmax(-1)
            steps.append(choice.cpu()); hist = torch.cat([hist, choice.unsqueeze(-1)], -1)
            pad = torch.cat([pad, torch.zeros((1, 1), dtype=torch.bool, device=self.device)], 1)
        return torch.stack(steps, -1).squeeze(0).numpy().astype(np.int64)

    @torch.inference_mode()
    def decode(self, tokens):
        ids = torch.as_tensor(tokens, dtype=torch.long, device=self.device)
        latent = torch.zeros((256, tokens.shape[1]), device=self.device)
        for lv in range(6): latent += self.codebooks[lv][:, ids[lv]]
        return (self.decoder(latent[None]).squeeze(0).T * self.std + self.mean).cpu().numpy().astype(np.float32)

    def generate(self, text):
        gloss = self.text_to_gloss(text)
        length = self.predict_length(gloss)
        tokens = self.generate_tokens(gloss, length)
        motion = self.decode(tokens)
        if not np.isfinite(motion).all(): raise RuntimeError("generated motion has NaN/Inf")
        return {"gloss": gloss, "length": length, "tokens": tokens, "motion": motion}
