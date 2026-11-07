// copy_call_libs.js - copies the PeerJS calling library into www/lib so the app does not depend on a website.
// Run inside bdsl-mobile, AFTER:   npm install peerjs
//     node tools/copy_call_libs.js
const fs = require("fs"), path = require("path");
const src = path.join("node_modules", "peerjs", "dist", "peerjs.min.js");
if (!fs.existsSync(src)) { console.error("Not found: " + src + "\nRun: npm install peerjs"); process.exit(1); }
fs.mkdirSync(path.join("www", "lib"), { recursive: true });
fs.copyFileSync(src, path.join("www", "lib", "peerjs.min.js"));
const v = JSON.parse(fs.readFileSync(path.join("node_modules", "peerjs", "package.json"))).version;
console.log(`copied PeerJS ${v} -> www/lib/peerjs.min.js`);
