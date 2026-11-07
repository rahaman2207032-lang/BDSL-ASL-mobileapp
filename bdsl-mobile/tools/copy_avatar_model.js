// copy_avatar_model.js - puts your 3D character into the app as www/models/avatar.vrm
// Run inside bdsl-mobile:   node tools/copy_avatar_model.js "C:\path\to\your-model.vrm"
const fs = require("fs"), path = require("path");
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('Give the path of a .vrm file, e.g.  node tools/copy_avatar_model.js "C:\\Users\\me\\Downloads\\model.vrm"'); process.exit(1); }
const head = fs.readFileSync(src).subarray(0, 4).toString();
if (head !== "glTF") { console.error("That file is not a VRM/glTF model."); process.exit(1); }
const dst = path.join(__dirname, "..", "www", "models", "avatar.vrm");
fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
console.log("Copied to", dst, `(${(fs.statSync(dst).size / 1e6).toFixed(1)} MB). Now run: npx cap copy android`);
