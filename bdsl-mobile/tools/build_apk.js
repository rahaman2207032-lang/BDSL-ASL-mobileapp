// build_apk.js - builds an installable, signed APK of the app. No USB, no "Run" in Android Studio.
//
// Run inside bdsl-mobile:
//   node tools/build_apk.js --user TURN_USERNAME --pass TURN_PASSWORD   (first time: ExpressTURN login -> calls between different networks)
//   node tools/build_apk.js                                              (later builds - the relay login is already saved)
//
// Result: BdSL-Sign.apk in the bdsl-mobile folder. Send it by WhatsApp / Drive / Bluetooth and install it on any Android phone.
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WIN = process.platform === "win32";
const step = (n, t) => console.log(`\n[${n}] ${t}`);
const run = (cmd, cwd = ROOT, env = process.env) => execSync(cmd, { cwd, stdio: "inherit", env, shell: true });
const fail = msg => { console.error("\n✖ " + msg); process.exit(1); };

// ---------- 1. relay for calls on different networks ----------
step(1, "Calls between different networks (TURN relay)");
if (process.argv.length > 2) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "set_turn.js"), ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.status !== 0) fail("The relay settings were not accepted - fix them and run again.");
}
const callJs = fs.readFileSync(path.join(ROOT, "www", "call.js"), "utf8");
const srv = (callJs.match(/const TURN_SERVERS = \[([\s\S]*?)\n  \];/) || [])[1] || "";
const turn = (callJs.match(/const TURN_CREDENTIALS_URL = "([^"]*)"/) || [])[1] || srv.split("\n").some(l => !/^\s*\/\//.test(l) && /turns?:/.test(l));
if (turn) console.log("✔ relay is set - calls will work on mobile data and on different Wi-Fi");
else console.log("✔ no relay set - calls work between phones on the same Wi-Fi");

// ---------- 2. make sure index.html has everything ----------
step(2, "Checking index.html");
if (fs.existsSync(path.join(__dirname, "add_call_tab.js"))) run(`node "${path.join(__dirname, "add_call_tab.js")}"`);
if (!fs.existsSync(path.join(ROOT, "www", "models", "avatar.vrm"))) console.log("⚠ www/models/avatar.vrm is missing - the app will use the 2D signer.");

// ---------- 3. Java (Android Studio already contains one) ----------
step(3, "Finding Java");
const env = { ...process.env };
// Windows calls it "Path", not "PATH" - keep the real one, or npx/node disappear for the child commands
const PATH_KEY = Object.keys(env).find(k => k.toUpperCase() === "PATH") || "PATH";
const javaOk = home => home && fs.existsSync(path.join(home, "bin", WIN ? "keytool.exe" : "keytool"));
const javaMajor = home => {
  try {
    const out = spawnSync(path.join(home, "bin", WIN ? "java.exe" : "java"), ["-version"], { encoding: "utf8" });
    const m = /version "(\d+)(?:\.(\d+))?/.exec((out.stderr || "") + (out.stdout || ""));
    return m ? (m[1] === "1" ? +m[2] : +m[1]) : 0;
  } catch (e) { return 0; }
};
// Gradle for Android needs Java 17 or 21. Android Studio's own Java ("jbr") is always the right one, so prefer it.
const studio = WIN
  ? ["C:\\Program Files\\Android\\Android Studio\\jbr", "C:\\Program Files\\Android\\Android Studio\\jre",
     path.join(os.homedir(), "AppData\\Local\\Programs\\Android Studio\\jbr"), "C:\\Program Files (x86)\\Android\\Android Studio\\jbr",
     "D:\\Program Files\\Android\\Android Studio\\jbr", "E:\\Program Files\\Android\\Android Studio\\jbr", "D:\\Android Studio\\jbr", "E:\\Android Studio\\jbr"]
  : ["/Applications/Android Studio.app/Contents/jbr/Contents/Home", "/opt/android-studio/jbr", path.join(os.homedir(), "android-studio/jbr")];
const good = h => javaOk(h) && javaMajor(h) >= 17 && javaMajor(h) <= 21;
const javaHome = [process.env.BDSL_JAVA_HOME, ...studio, process.env.JAVA_HOME].find(good);
if (!javaHome) {
  const v = javaOk(process.env.JAVA_HOME) ? ` (JAVA_HOME is Java ${javaMajor(process.env.JAVA_HOME)} - too new/old for Android builds)` : "";
  fail("No Java 17 or 21 found" + v + ".\nFind Android Studio's 'jbr' folder (Android Studio -> Settings -> Build Tools -> Gradle -> Gradle JDK shows the path), then run:\n" +
       '  set BDSL_JAVA_HOME=C:\\Program Files\\Android\\Android Studio\\jbr\n  node tools\\build_apk.js');
}
env.JAVA_HOME = javaHome;
env[PATH_KEY] = path.join(javaHome, "bin") + path.delimiter + (env[PATH_KEY] || "");
console.log(`✔ Java ${javaMajor(javaHome)}:`, javaHome);

// ---------- 4. signing key (made once, reused for every update) ----------
step(4, "Signing key");
const KDIR = path.join(ROOT, "android-keystore"), KS = path.join(KDIR, "bdsl-release.jks"), KJ = path.join(KDIR, "keystore.json");
let key;
if (fs.existsSync(KS) && fs.existsSync(KJ)) { key = JSON.parse(fs.readFileSync(KJ, "utf8")); console.log("✔ using existing key", KS); }
else {
  fs.mkdirSync(KDIR, { recursive: true });
  key = { alias: "bdsl", password: crypto.randomBytes(12).toString("hex") };
  run(`keytool -genkeypair -noprompt -v -keystore "${KS}" -alias ${key.alias} -keyalg RSA -keysize 2048 -validity 10000 ` +
      `-storepass ${key.password} -keypass ${key.password} -dname "CN=BdSL Sign Player, OU=Student Project, O=BdSL, C=BD"`, ROOT, env);
  fs.writeFileSync(KJ, JSON.stringify(key, null, 2));
  const gi = path.join(ROOT, ".gitignore");
  if (fs.existsSync(gi) && !fs.readFileSync(gi, "utf8").includes("android-keystore")) fs.appendFileSync(gi, "\nandroid-keystore/\n*.apk\n");
  console.log("✔ new key created in android-keystore/  -> BACK UP this folder. Updates must be signed with the same key.");
}

// ---------- 5. copy the web app into the Android project ----------
step(5, "Copying the app into the Android project (npx cap sync android)");
run("npx cap sync android", ROOT, env);

// ---------- 6. build the signed release APK ----------
step(6, "Building the APK (first time takes a few minutes)");
const AND = path.join(ROOT, "android");
const gradlew = WIN ? "gradlew.bat" : "./gradlew";
if (!WIN) try { fs.chmodSync(path.join(AND, "gradlew"), 0o755); } catch (e) {}
run(`${gradlew} assembleRelease --no-daemon ` +
    `-Pandroid.injected.signing.store.file="${KS}" -Pandroid.injected.signing.store.password=${key.password} ` +
    `-Pandroid.injected.signing.key.alias=${key.alias} -Pandroid.injected.signing.key.password=${key.password}`, AND, env);

// ---------- 7. hand it over ----------
const outDir = path.join(AND, "app", "build", "outputs", "apk", "release");
const apk = fs.existsSync(outDir) && fs.readdirSync(outDir).filter(f => f.endsWith(".apk") && !f.includes("unsigned"))[0];
if (!apk) fail("Build finished but no signed APK was found in " + outDir);
const dest = path.join(ROOT, "BdSL-Sign.apk");
fs.copyFileSync(path.join(outDir, apk), dest);
console.log(`\n✔ DONE: ${dest}  (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)` +
  `\n  Send it to the phones (WhatsApp / Drive / Bluetooth / cable copy) and tap it to install.` +
  `\n  ${turn ? "Calls: any network." : "Calls: SAME Wi-Fi only (no relay link set)."}`);
