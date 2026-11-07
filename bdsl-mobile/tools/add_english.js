// add_english.js - turns on the English (ASL) half of the app. Safe to run again.
// Run inside bdsl-mobile:
//   node tools/add_english.js "E:\path\to\System-Project---Sign-Language"
// 1. copies holistic_landmarker.task (face + hands + pose, needed for ASL)  -> www/models/
// 2. copies asl_model.tflite (your ASL sign -> word model)                   -> english-server/asl/
// 3. puts lang.js into index.html and refreshes camera.js
// 4. lets the Android app talk to the English engine on your PC (plain http on the home Wi-Fi)
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), WWW = path.join(ROOT, "www");
const ok = m => console.log("✔ " + m), warn = m => console.log("⚠ " + m);
if (!fs.existsSync(path.join(WWW, "index.html"))) { console.error("Run this inside the bdsl-mobile folder."); process.exit(1); }

// ---- 1 + 2: model files from your repo ----
const repo = process.argv[2];
function findIn(dir, name, depth = 4) {
  if (!dir || depth < 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory() && !/^(\.git|node_modules)$/.test(e.name)) { const r = findIn(p, name, depth - 1); if (r) return r; }
  }
  return null;
}
const copy = (src, dst, label) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); ok(`${label} -> ${path.relative(ROOT, dst)} (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`); };
const holDst = path.join(WWW, "models", "holistic_landmarker.task");
const aslDst = path.join(ROOT, "english-server", "asl", "asl_model.tflite");
if (repo) {
  const h = findIn(repo, "holistic_landmarker.task"); h ? copy(h, holDst, "holistic_landmarker.task") : warn("holistic_landmarker.task not found in " + repo);
  const a = findIn(repo, "asl_model.tflite", 6); a ? copy(a, aslDst, "asl_model.tflite") : warn("asl_model.tflite not found in " + repo);
} else if (!fs.existsSync(holDst) || !fs.existsSync(aslDst)) {
  warn('Give the path of your GitHub repo folder so the models can be copied:\n  node tools/add_english.js "E:\\path\\to\\System-Project---Sign-Language"');
}
for (const f of ["lang.js", "en/sentences.json", "en/asl_words.json", "camera.js", "sign-engine.js", "call.js"])
  if (!fs.existsSync(path.join(WWW, f))) warn("www/" + f + " is missing - copy the www folder from the zip");

// ---- 3: index.html ----
const idx = path.join(WWW, "index.html"); let html = fs.readFileSync(idx, "utf8"); const before = html;
html = html.replace(/src="camera\.js(\?v=\d+)?"/, 'src="camera.js?v=8"');
if (html !== before) { fs.writeFileSync(idx, html); ok("camera.js refreshed (v8)"); }
require("child_process").execSync(`node "${path.join(__dirname, "add_call_tab.js")}"`, { cwd: ROOT, stdio: "inherit" });

// ---- 4: allow http to the PC on the local network (Android) ----
const cfgJson = path.join(ROOT, "capacitor.config.json"), cfgTs = ["capacitor.config.ts", "capacitor.config.js"].map(f => path.join(ROOT, f)).find(fs.existsSync);
if (fs.existsSync(cfgJson)) {
  const c = JSON.parse(fs.readFileSync(cfgJson, "utf8"));
  c.android = { ...(c.android || {}), allowMixedContent: true }; c.server = { ...(c.server || {}), cleartext: true };
  fs.writeFileSync(cfgJson, JSON.stringify(c, null, 2) + "\n"); ok("capacitor.config.json: allowMixedContent + cleartext");
} else if (cfgTs) {
  let t = fs.readFileSync(cfgTs, "utf8"); const t0 = t;
  if (!/allowMixedContent/.test(t)) t = /\bandroid\s*:\s*\{/.test(t) ? t.replace(/\bandroid\s*:\s*\{/, m => m + " allowMixedContent: true,") : t.replace(/(=\s*\{)/, "$1\n  android: { allowMixedContent: true },");
  if (!/cleartext/.test(t)) t = /\bserver\s*:\s*\{/.test(t) ? t.replace(/\bserver\s*:\s*\{/, m => m + " cleartext: true,") : t.replace(/(=\s*\{)/, "$1\n  server: { cleartext: true },");
  if (t !== t0) { fs.writeFileSync(cfgTs, t); ok(path.basename(cfgTs) + ": allowMixedContent + cleartext"); } else ok(path.basename(cfgTs) + " already allows the PC engine");
} else warn("capacitor.config.* not found - skipped the Android network setting");
const man = path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml");
if (fs.existsSync(man)) {
  let m = fs.readFileSync(man, "utf8");
  if (!/usesCleartextTraffic/.test(m)) { m = m.replace(/<application\b/, '<application android:usesCleartextTraffic="true"'); fs.writeFileSync(man, m); ok("AndroidManifest.xml: usesCleartextTraffic"); }
  else ok("AndroidManifest.xml already allows http on the local network");
}
console.log("\nNext:  1) start the English engine:  cd english-server  &&  python server.py\n       2) npx cap sync android   (or node tools/build_apk.js)\n       3) in the app: English -> Engine -> type the address server.py printed");
