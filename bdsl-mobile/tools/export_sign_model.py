"""
export_sign_model.py - turn the trained word recognizer into files the app can load.

    python export_sign_model.py  word_gru.pt  config.json  OUT_FOLDER

Writes two files into OUT_FOLDER:
    sign_gru.bin      all model weights as little-endian float32, one after another
    sign_model.json   config.json + where each weight sits inside sign_gru.bin

Run it again every time you retrain (Notebook 2 gives you a new word_gru.pt + config.json).
Works with PyTorch installed, and also WITHOUT it (it can read the .pt zip directly).
"""
import json, os, pickle, sys, zipfile
import numpy as np


def load_state_dict(pt_path):
    try:
        import torch
        sd = torch.load(pt_path, map_location="cpu")
        return {k: v.detach().cpu().numpy().astype(np.float32) for k, v in sd.items()}
    except ImportError:
        pass
    # ---- torch-free reader for the standard zip checkpoint format ----
    zf = zipfile.ZipFile(pt_path)
    names = zf.namelist()
    root = names[0].split("/")[0]
    dtypes = {"FloatStorage": np.float32, "DoubleStorage": np.float64, "HalfStorage": np.float16,
              "LongStorage": np.int64, "IntStorage": np.int32, "BFloat16Storage": None}

    class Storage:
        def __init__(self, key, dtype): self.key, self.dtype = key, dtype

    def rebuild_tensor(storage, offset, size, stride, *args):
        raw = np.frombuffer(zf.read(f"{root}/data/{storage.key}"), dtype=storage.dtype)
        if len(size) == 0:
            return raw[offset:offset + 1].reshape(())
        return np.lib.stride_tricks.as_strided(
            raw[offset:], shape=tuple(size),
            strides=tuple(s * raw.itemsize for s in stride)).copy()

    class U(pickle.Unpickler):
        def find_class(self, mod, name):
            if name == "_rebuild_tensor_v2": return rebuild_tensor
            if name in dtypes: return name
            if mod == "collections" and name == "OrderedDict":
                import collections; return collections.OrderedDict
            if name == "_rebuild_parameter": return lambda t, *a: t
            return super().find_class(mod, name)

        def persistent_load(self, pid):
            _, stype, key, _loc, _n = pid
            return Storage(key, dtypes[stype])

    sd = U(zf.open(f"{root}/data.pkl")).load()
    return {k: np.asarray(v, np.float32) for k, v in sd.items()}


def main(pt, cfg_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    sd = load_state_dict(pt)
    index, blobs, off = {}, [], 0
    for k, v in sd.items():
        a = np.ascontiguousarray(v, dtype="<f4")
        index[k] = {"offset": off, "shape": list(a.shape)}
        blobs.append(a.tobytes()); off += a.size
    open(os.path.join(out_dir, "sign_gru.bin"), "wb").write(b"".join(blobs))
    cfg["tensors"] = index
    cfg["hidden"] = int(sd["gru.weight_hh_l0"].shape[1])
    cfg["layers"] = sum(1 for k in sd if k.startswith("gru.weight_ih_l") and not k.endswith("_reverse"))
    json.dump(cfg, open(os.path.join(out_dir, "sign_model.json"), "w", encoding="utf-8"),
              ensure_ascii=False)
    print(f"wrote {off * 4 / 1e6:.1f} MB of weights, {len(index)} tensors, "
          f"{len(cfg['classes'])} words, feat={cfg['feat']}, hidden={cfg['hidden']}, layers={cfg['layers']}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
