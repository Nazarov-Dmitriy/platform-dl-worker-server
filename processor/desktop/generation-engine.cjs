"use strict";
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { createHash, randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFile, spawnSync } = require("node:child_process");
const manifest = require("./generation-engine-manifest.json");

function selectBuild(platform = process.platform, arch = process.arch, nvidia) {
  if (nvidia === undefined && platform === "win32") {
    const result = spawnSync("nvidia-smi", ["-L"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    nvidia = !result.error && result.status === 0;
  }
  const key = platform === "win32" && arch === "x64" && nvidia ? "win32-x64-cuda"
    : platform === "darwin" && arch === "arm64" ? "darwin-arm64-metal" : null;
  return key ? { key, version: manifest.version, ...manifest.builds[key] } : null;
}
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args,
    { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 ** 2, ...options },
    (error, stdout, stderr) => error ? reject(error) : resolve(String(stdout) + String(stderr))));
}
function currentMacOSVersion() {
  if (process.platform !== "darwin") return undefined;
  const result = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 5000 });
  return !result.error && result.status === 0 ? result.stdout.trim() : undefined;
}
function macOSSupported(build, version) {
  if (!build.minimumMacOS) return true;
  if (!/^\d+(?:\.\d+)*$/.test(version || "")) return false;
  const parts = version.split(".").map(Number), minimum = build.minimumMacOS.split(".").map(Number);
  for (let i = 0; i < Math.max(parts.length, minimum.length); i++) {
    if ((parts[i] || 0) !== (minimum[i] || 0)) return (parts[i] || 0) > (minimum[i] || 0);
  }
  return true;
}
function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function removeStage(root, target) {
  if (!contained(root, target)) throw Error("GENERATION_PATH_INVALID");
  fs.rmSync(target, { recursive: true, force: true });
}
function inspectTree(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw Error("GENERATION_ARCHIVE_SYMLINK");
    if (entry.isDirectory()) files.push(...inspectTree(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
async function extract(archive, destination, platform) {
  if (platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(__dirname, "generation-extract.ps1"), "-Archive", archive, "-Destination", destination]);
  } else {
    const list = await run("/usr/bin/unzip", ["-Z1", archive]);
    for (const entry of list.split(/\r?\n/).filter(Boolean)) {
      if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")) throw Error("GENERATION_ARCHIVE_PATH");
    }
    // Reject links before extraction; a link could redirect later archive entries.
    const listing = await run("/usr/bin/unzip", ["-Z", "-l", archive]);
    if (listing.split(/\r?\n/).some(line => /^l[rwx-]{9}\s/.test(line))) throw Error("GENERATION_ARCHIVE_SYMLINK");
    await run("/usr/bin/unzip", ["-q", archive, "-d", destination]);
  }
  inspectTree(destination);
}
function download(archive, destination, onProgress, url = archive.url, redirects = 0) {
  if (redirects > 8 || new URL(url).protocol !== "https:") return Promise.reject(Error("GENERATION_DOWNLOAD_REDIRECT"));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: true }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) return reject(Error("GENERATION_DOWNLOAD_FAILED"));
        download(archive, destination, onProgress, new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(Error("GENERATION_DOWNLOAD_FAILED")); return; }
      const hash = createHash("sha256");
      let received = 0;
      const meter = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > archive.bytes) { callback(Error("GENERATION_SIZE_MISMATCH")); return; }
        hash.update(chunk); onProgress(received); callback(null, chunk);
      } });
      pipeline(response, meter, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }))
        .then(() => {
          if (received !== archive.bytes) throw Error("GENERATION_SIZE_MISMATCH");
          if (hash.digest("hex") !== archive.sha256) throw Error("GENERATION_HASH_MISMATCH");
          resolve();
        }).catch(reject);
    });
    request.on("error", reject);
    request.setTimeout(120000, () => request.destroy(Error("GENERATION_DOWNLOAD_TIMEOUT")));
  });
}
function checkExecutable(executable, accelerator) {
  const result = spawnSync(executable, ["--help"], { cwd: path.dirname(executable), windowsHide: true,
    encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 ** 2 });
  if (result.error || result.status !== 0 || !/--diffusion-model\b/.test(String(result.stdout) + String(result.stderr))) return false;
  if (!accelerator) return true;
  const devices = spawnSync(executable, ["--list-devices"], { cwd: path.dirname(executable), windowsHide: true,
    encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 ** 2 });
  const output = String(devices.stdout) + String(devices.stderr);
  const expected = accelerator === "cuda" ? /^cuda\d*\t/im : /^(?:metal|mtl)\d*\t/im;
  return !devices.error && devices.status === 0 && expected.test(output);
}
function readiness(saved, build = selectBuild(), check = checkExecutable, macOSVersion = currentMacOSVersion()) {
  if (!build) return { ok: false, supported: false, missing: ["stable-diffusion.cpp"],
    message: "Автоматическая установка пока доступна для Windows x64 с NVIDIA и Mac с Apple Silicon." };
  if (!macOSSupported(build, macOSVersion)) return { ok: false, supported: false,
    build: build.key, version: build.version, label: build.label, missing: ["stable-diffusion.cpp"],
    message: "Для этой официальной сборки движка нужна macOS " + build.minimumMacOS + " или новее. " +
      (macOSVersion ? "На компьютере macOS " + macOSVersion + "." : "Версия macOS не определена.") };
  const same = saved?.generationEngine?.version === build.version && saved.generationEngine.build === build.key;
  const executable = same ? saved.generationEngine.executable : null;
  const ok = !!executable && fs.existsSync(executable) && check(executable, build.accelerator);
  return { ok, supported: true, build: build.key, version: build.version, label: build.label,
    downloadBytes: build.archives.reduce((sum, archive) => sum + archive.bytes, 0),
    missing: ok ? [] : ["stable-diffusion.cpp"],
    message: ok ? "Движок запускается с " + (build.accelerator === "cuda" ? "CUDA" : "Metal") + ". Генерация с моделью ещё не проверена."
      : "Установите движок генерации. Готовность модели проверяется отдельно." };
}
const installations = new Set();
async function install(directory, { build = selectBuild(), platform = process.platform,
  macOSVersion = currentMacOSVersion(), onProgress = () => {}, transfer = download, unpack = extract, check = checkExecutable } = {}) {
  if (!build) throw Error("GENERATION_PLATFORM_UNSUPPORTED");
  if (!macOSSupported(build, macOSVersion)) throw Error("GENERATION_MACOS_VERSION");
  const tools = path.resolve(directory, "tools", "generation");
  if (installations.has(tools)) throw Error("GENERATION_INSTALL_BUSY");
  installations.add(tools);
  let stage;
  try {
    fs.mkdirSync(tools, { recursive: true, mode: 0o700 });
    stage = fs.mkdtempSync(path.join(tools, ".install-"));
    const total = build.archives.reduce((sum, archive) => sum + archive.bytes, 0);
    const disk = fs.statfsSync(tools);
    if (disk.bavail * disk.bsize < total * 4 + 256 * 1024 ** 2) throw Error("GENERATION_INSUFFICIENT_DISK");
    const output = path.join(stage, "engine");
    fs.mkdirSync(output);
    let completed = 0;
    for (const [index, archive] of build.archives.entries()) {
      const zip = path.join(stage, "archive-" + index + ".zip");
      await transfer(archive, zip, received => onProgress({ phase: "downloading", progress: (completed + received) / total }));
      // Verify again here so injected transports and future download implementations
      // cannot bypass integrity checks before extraction.
      const hash = createHash("sha256");
      let length = 0;
      for await (const chunk of fs.createReadStream(zip)) { length += chunk.length; hash.update(chunk); }
      if (length !== archive.bytes || hash.digest("hex") !== archive.sha256) throw Error("GENERATION_HASH_MISMATCH");
      const extracted = path.join(stage, "extracted-" + index);
      fs.mkdirSync(extracted);
      onProgress({ phase: "extracting", progress: (completed + archive.bytes) / total });
      await unpack(zip, extracted, platform);
      // All DLLs must live beside sd-cli.exe on Windows. The official archives
      // may contain a bin/ directory, so normalise the dependency directory.
      for (const file of inspectTree(extracted)) {
        const target = platform === "win32" ? path.join(output, path.basename(file)) : path.join(output, path.relative(extracted, file));
        if (fs.existsSync(target)) {
          const digest = name => createHash("sha256").update(fs.readFileSync(name)).digest("hex");
          if (digest(file) === digest(target)) continue;
          if (/\.(dll|exe)$/i.test(file)) throw Error("GENERATION_ARCHIVE_COLLISION");
          const document = path.join(output, "archive-" + index, path.basename(file));
          fs.mkdirSync(path.dirname(document), { recursive: true });
          fs.copyFileSync(file, document);
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
        if (platform !== "win32") fs.chmodSync(target, fs.statSync(file).mode);
      }
      completed += archive.bytes;
    }
    const executable = inspectTree(output).find(file => path.basename(file) === build.executable);
    if (!executable) throw Error("GENERATION_EXECUTABLE_MISSING");
    if (platform !== "win32") fs.chmodSync(executable, 0o755);
    onProgress({ phase: "checking", progress: 1 });
    if (!check(executable, build.accelerator)) throw Error("GENERATION_EXECUTABLE_UNAVAILABLE");
    const destination = path.join(tools, build.version + "-" + build.key + "-" + randomUUID());
    const relativeExe = path.relative(output, executable);
    fs.renameSync(output, destination);
    return { version: build.version, build: build.key, executable: path.join(destination, relativeExe) };
  } finally {
    if (stage) removeStage(tools, stage);
    installations.delete(tools);
  }
}
module.exports = { manifest, selectBuild, readiness, install, checkExecutable, contained, extract, macOSSupported };
