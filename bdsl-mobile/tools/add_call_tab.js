// add_call_tab.js - adds (or UPGRADES) the Call tab in YOUR app (www/index.html).
// Run inside bdsl-mobile:   node tools/add_call_tab.js      (safe to run again; backup: www/index.html.bak)
const fs = require("fs"), path = require("path");
const WWW = "www", SNIP = path.join(__dirname, "..", "snippets");
const snip = n => { const f = path.join(SNIP, n); if (!fs.existsSync(f)) { console.error("Missing " + f + " - copy the kit's snippets folder into bdsl-mobile."); process.exit(1); } return fs.readFileSync(f, "utf8"); };
const indexPath = path.join(WWW, "index.html");
if (!fs.existsSync(indexPath)) { console.error("Can't find " + indexPath + " - run this inside the bdsl-mobile folder."); process.exit(1); }
const TAB = snip("4-call-tab-button.html"), SECTION = snip("5-call-section.html"), SCRIPTS = snip("6-call-scripts.html");
let html = fs.readFileSync(indexPath, "utf8"); const before = html; const did = [];

if (!/data-v="call"/.test(html)) {
  const after = html.match(/[ \t]*<button[^>]*data-v="sign"[^>]*>[\s\S]*?<\/button>[ \t]*\r?\n?/) ||
                html.match(/[ \t]*<button[^>]*data-v="practice"[^>]*>[\s\S]*?<\/button>[ \t]*\r?\n?/);
  if (!after) { console.error("Could not find the tab buttons in index.html"); process.exit(1); }
  html = html.replace(after[0], after[0].replace(/\r?\n?$/, "\n") + TAB); did.push("added Call tab button");
}
const old = html.match(/[ \t]*(<!-- =+ CALL: VIDEO CALL[^>]*-->\s*)?<section id="view-call"[\s\S]*?<\/section>[ \t]*\r?\n?/);
if (old) { html = html.replace(old[0], SECTION); did.push("replaced the call section"); }
else { if (!html.includes("</main>")) { console.error("Could not find </main>"); process.exit(1); } html = html.replace("</main>", SECTION + "</main>"); did.push("added the call section"); }

html = html.replace(/[ \t]*<script type="importmap">[^<]*<\/script>[ \t]*\r?\n?/g, "");
html = html.replace(/[ \t]*<script[^>]*src="(avatar\.js|avatar3d\.js|call-mini\.js|ui-pro\.js|lang\.js|lib\/peerjs\.min\.js|sign-engine\.js|call\.js)[^"]*"[^>]*><\/script>[ \t]*\r?\n?/g, "");
// professional theme: ui-pro.css right after style.css (once)
html = html.replace(/[ \t]*<link[^>]*href="ui-pro\.css[^"]*"[^>]*>[ \t]*\r?\n?/g, "");
const css = html.match(/<link[^>]*href="style\.css[^"]*"[^>]*>[ \t]*\r?\n?/);
if (css) { html = html.replace(css[0], css[0].replace(/\r?\n?$/, "\n") + '  <link rel="stylesheet" href="ui-pro.css?v=1">\n'); did.push("ui-pro.css linked"); }
const anchor = html.match(/<script[^>]*src="camera\.js[^"]*"[^>]*><\/script>[ \t]*\r?\n?/) || html.match(/<script[^>]*src="app\.js[^"]*"[^>]*><\/script>[ \t]*\r?\n?/);
if (!anchor) { console.error('Could not find <script src="app.js"> in index.html'); process.exit(1); }
html = html.replace(anchor[0], anchor[0].replace(/\r?\n?$/, "\n") + SCRIPTS); did.push("call scripts placed after " + (anchor[0].includes("camera") ? "camera.js" : "app.js"));

if (html !== before) { fs.writeFileSync(indexPath + ".bak", before); fs.writeFileSync(indexPath, html); }
console.log("index.html: " + did.join("; "));
const need = ["lang.js", "en/sentences.json", "en/asl_words.json", "lib/peerjs.min.js", "sign-engine.js", "call.js", "call-mini.js", "ui-pro.js", "ui-pro.css", "avatar.js", "avatar3d.js", "lib/three/three.module.min.js", "sign-worker.js", "recognize.js", "models/sign/sign_model.json", "mediapipe/vision_bundle.js"];
const missing = need.filter(f => !fs.existsSync(path.join(WWW, f)));
if (missing.length) console.log("STILL MISSING in www/: " + missing.join(", ") +
  (missing.includes("lib/peerjs.min.js") ? "\n  -> run: npm install peerjs   and then   node tools/copy_call_libs.js" : ""));
else console.log("All call files are in place. Reload with Ctrl+Shift+R.");
