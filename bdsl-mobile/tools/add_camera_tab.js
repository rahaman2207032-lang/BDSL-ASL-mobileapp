// add_camera_tab.js - adds (or UPGRADES) the Camera tab in YOUR existing app (www/index.html + www/style.css).
// Run inside bdsl-mobile:      node tools/add_camera_tab.js
// Safe to run again: it replaces the old camera section and camera.js line with the current ones.
// Backups of your files before each run: www/index.html.bak, www/style.css.bak
const fs = require("fs"), path = require("path");
const WWW = "www", SNIP = path.join(__dirname, "..", "snippets");
const read = f => fs.readFileSync(f, "utf8");
const snip = name => {
  const f = path.join(SNIP, name);
  if (!fs.existsSync(f)) { console.error("Missing " + f + "\nCopy the kit's 'snippets' folder into bdsl-mobile (next to 'tools')."); process.exit(1); }
  return read(f);
};
const indexPath = path.join(WWW, "index.html"), cssPath = path.join(WWW, "style.css");
if (!fs.existsSync(indexPath)) { console.error("Can't find " + indexPath + " - run this inside the bdsl-mobile folder."); process.exit(1); }

const TAB = snip("1-tab-button.html"), SECTION = snip("2-camera-section.html"), SCRIPT = snip("3-script-tag.html");
let html = read(indexPath); const before = html; const did = [];

// 1) tab button (add once, right after the Practice tab button)
if (!/data-v="sign"/.test(html)) {
  const practice = html.match(/[ \t]*<button[^>]*data-v="practice"[^>]*>[\s\S]*?<\/button>[ \t]*\r?\n?/);
  if (!practice) { console.error('Could not find the Practice tab button (data-v="practice") in index.html'); process.exit(1); }
  html = html.replace(practice[0], practice[0].replace(/\r?\n?$/, "\n") + TAB);
  did.push("added Camera tab button");
}

// 2) camera section: replace an old one if present, otherwise add before </main>
const oldSection = html.match(/[ \t]*(<!-- =+ CAMERA: SIGN -> TEXT =+ -->\s*)?<section id="view-sign"[\s\S]*?<\/section>[ \t]*\r?\n?/);
if (oldSection) { html = html.replace(oldSection[0], SECTION); did.push("replaced the camera section with the current one"); }
else {
  if (!html.includes("</main>")) { console.error("Could not find </main> in index.html"); process.exit(1); }
  html = html.replace("</main>", SECTION + "</main>"); did.push("added the camera section");
}

// 3) exactly one camera.js line, right after app.js
html = html.replace(/[ \t]*<script[^>]*src="camera\.js[^"]*"[^>]*><\/script>[ \t]*\r?\n?/g, "");
const appTag = html.match(/<script[^>]*src="app\.js[^"]*"[^>]*><\/script>[ \t]*\r?\n?/);
if (!appTag) { console.error('Could not find <script src="app.js"></script> in index.html'); process.exit(1); }
html = html.replace(appTag[0], appTag[0].replace(/\r?\n?$/, "\n") + SCRIPT);
did.push("camera.js line placed after app.js");

if (html !== before) { fs.writeFileSync(indexPath + ".bak", before); fs.writeFileSync(indexPath, html); }

// 4) styles in style.css too (the camera section also carries its own copy, so this is a backup)
let css = read(cssPath);
if (!css.includes(".cam-card")) {
  fs.writeFileSync(cssPath + ".bak", css);
  fs.writeFileSync(cssPath, css.replace(/\s*$/, "\n\n") + snip("style-additions.css"));
  did.push("added camera styles to style.css");
}

console.log("index.html: " + did.join("; "));
const need = ["camera.js", "sign-worker.js", "recognize.js", "models/sign/sign_model.json", "models/sign/sign_gru.bin",
              "models/pose_landmarker_lite.task", "models/hand_landmarker.task", "mediapipe/vision_bundle.js"];
const missing = need.filter(f => !fs.existsSync(path.join(WWW, f)));
if (missing.length) console.log("STILL MISSING in www/: " + missing.join(", ") +
  (missing.includes("mediapipe/vision_bundle.js") ? "\n  -> run: npm install @mediapipe/tasks-vision  and then  node tools/copy_mediapipe.js" : ""));
else console.log("All camera files are in place. Now reload the page with Ctrl+Shift+R.");
const cam = path.join(WWW, "camera.js");
if (fs.existsSync(cam) && !read(cam).includes("__cameraReady"))
  console.log("WARNING: www/camera.js is an OLD version. Copy the newest camera.js from the kit into www.");
