// verify_js.js - step 2 of the check: runs the app's model (www/recognize.js + www/models/sign) on the clips
// saved by verify_against_pytorch.py and compares with PyTorch's answers.   Run inside bdsl-mobile:
//     node tools/verify_js.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const SignRecognizer = require(path.join(root, "www", "recognize.js"));
const M = path.join(root, "www", "models", "sign");
const cfg = JSON.parse(fs.readFileSync(path.join(M, "sign_model.json"), "utf8"));
const bin = fs.readFileSync(path.join(M, "sign_gru.bin"));
const rec = new SignRecognizer(cfg, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const casesPath = path.join(__dirname, "verify_cases.json");
if (!fs.existsSync(casesPath)) { console.error("Run first:  python tools/verify_against_pytorch.py word_gru.pt config.json"); process.exit(1); }
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
let same = 0, worst = 0;
cases.forEach((c, i) => {
  const frames = c.frames.map(f => Float32Array.from(f));
  const lg = rec.forward(rec.featurize(frames));
  const mx = Math.max(...lg), e = lg.map(v => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0);
  let diff = 0; e.forEach((v, k) => { diff = Math.max(diff, Math.abs(v / s - c.probs[k])); });
  const top = cfg.classes[e.indexOf(Math.max(...e))];
  if (top === c.top) same++; worst = Math.max(worst, diff);
  console.log(`clip ${String(i + 1).padStart(2)}: ${c.frames.length} frames | PyTorch ${c.top} | app ${top} | biggest probability difference ${diff.toExponential(1)}`);
});
console.log(`\nSame top word on ${same}/${cases.length} clips; biggest probability difference ${worst.toExponential(1)}`);
console.log(same === cases.length && worst < 1e-3 ? "PASS: the app runs the same model as your PyTorch code."
                                                  : "MISMATCH: send this output to me.");
