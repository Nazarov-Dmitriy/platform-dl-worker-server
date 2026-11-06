// Downloads only the pinned engine, never model weights or account credentials.
const path = require("node:path");
const engine = require("../desktop/generation-engine.cjs");
const directory = path.resolve(process.argv[2] || path.join(__dirname, "../../bin/generation-engine-smoke"));
let previous = "";
engine.install(directory, { onProgress: value => {
  const message = value.phase + " " + Math.floor((value.progress || 0) * 10) * 10 + "%";
  if (message !== previous) { previous = message; console.log(message); }
} }).then(installed => {
  const result = engine.readiness({ generationEngine: installed });
  if (!result.ok) throw Error("Installed engine failed its launch check");
  console.log(JSON.stringify({ version: installed.version, build: installed.build, executable: installed.executable, launchVerified: true }));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
