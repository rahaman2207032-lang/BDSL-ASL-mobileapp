// copy_mediapipe.js - copies MediaPipe's web files into www/mediapipe so the app works offline.
// Run inside bdsl-mobile, AFTER:   npm install @mediapipe/tasks-vision
//     node tools/copy_mediapipe.js
const fs = require("fs"), path = require("path");
const src = path.join("node_modules", "@mediapipe", "tasks-vision");
if (!fs.existsSync(src)) { console.error("Not found: " + src + "\nRun: npm install @mediapipe/tasks-vision"); process.exit(1); }
const dst = path.join("www", "mediapipe");
fs.mkdirSync(path.join(dst, "wasm"), { recursive: true });
const bundle = fs.readdirSync(src).find(f => /^vision_bundle.*\.mjs$/.test(f));
if (!bundle) { console.error("vision_bundle.mjs not found in " + src); process.exit(1); }
// saved as .js on purpose: some servers (and old Android WebViews) don't serve .mjs with a JavaScript type
fs.copyFileSync(path.join(src, bundle), path.join(dst, "vision_bundle.js"));
let n = 0;
for (const f of fs.readdirSync(path.join(src, "wasm"))) { fs.copyFileSync(path.join(src, "wasm", f), path.join(dst, "wasm", f)); n++; }
const v = JSON.parse(fs.readFileSync(path.join(src, "package.json"))).version;
console.log(`copied MediaPipe tasks-vision ${v}: ${bundle} -> www/mediapipe/vision_bundle.js, ${n} wasm files -> www/mediapipe/wasm/`);
