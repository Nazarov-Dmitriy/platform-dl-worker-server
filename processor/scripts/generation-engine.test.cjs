const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const engine = require("../desktop/generation-engine.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-generation-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = Buffer.from("verified engine archive");
  const archive = { url: "https://example.invalid/pinned.zip", bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex") };
  const build = { key: "test-cuda", version: "test-1", executable: "sd-cli.exe", label: "test", archives: [archive] };
  const transfer = async (metadata, destination, progress) => { fs.writeFileSync(destination, payload); progress(payload.length); };
  const unpack = async (zip, destination) => { fs.mkdirSync(path.join(destination, "bin")); fs.writeFileSync(path.join(destination, "bin/sd-cli.exe"), "engine"); };
  return { root, build, transfer, unpack, platform: "win32", check: () => true };
}
test("pinned installer chooses CUDA and Metal explicitly and declines unsupported platforms", () => {
  assert.equal(engine.selectBuild("win32", "x64", true).accelerator, "cuda");
  assert.equal(engine.selectBuild("darwin", "arm64").accelerator, "metal");
  for (const args of [["win32", "x64", false], ["darwin", "x64"], ["linux", "x64"]])
    assert.equal(engine.selectBuild(...args), null);
  for (const build of Object.values(engine.manifest.builds)) {
    for (const archive of build.archives) {
      assert.ok(archive.url.includes("/download/" + engine.manifest.version + "/"));
      assert.match(archive.sha256, /^[a-f0-9]{64}$/);
      assert.ok(archive.bytes > 0);
    }
  }
});
test("installer verifies a package, normalises the executable directory and requires a successful launch", async t => {
  const f = fixture(t);
  const progress = [];
  const installed = await engine.install(f.root, { ...f, onProgress: value => progress.push(value.phase) });
  assert.equal(fs.readFileSync(installed.executable, "utf8"), "engine");
  assert.deepEqual(progress, ["downloading", "extracting", "checking"]);
  assert.equal(engine.readiness({ generationEngine: installed }, f.build, () => true).ok, true);
  assert.equal(engine.readiness({ generationEngine: installed }, f.build, () => false).ok, false);
  assert.equal(engine.readiness({ generationEngine: installed }, { ...f.build, version: "next" }, () => true).ok, false);
  assert.ok(!fs.readdirSync(path.join(f.root, "tools/generation")).some(name => name.startsWith(".install-")));
});
test("corrupt archives never execute or replace a working engine", async t => {
  const f = fixture(t);
  const installed = await engine.install(f.root, f);
  let unpacked = false;
  await assert.rejects(engine.install(f.root, { ...f,
    transfer: async (metadata, destination) => fs.writeFileSync(destination, "corrupt"),
    unpack: async () => { unpacked = true; },
  }), /GENERATION_HASH_MISMATCH/);
  assert.equal(unpacked, false);
  assert.equal(fs.readFileSync(installed.executable, "utf8"), "engine");
  await assert.rejects(engine.install(f.root, { ...f, check: () => false }), /GENERATION_EXECUTABLE_UNAVAILABLE/);
  assert.equal(fs.readFileSync(installed.executable, "utf8"), "engine");
  assert.equal(fs.readdirSync(path.join(f.root, "tools/generation")).length, 1);
});
test("installer refuses a second concurrent operation and cleans a failed download", async t => {
  const f = fixture(t);
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const first = engine.install(f.root, { ...f, transfer: async () => { await gate; throw Error("network unavailable"); } });
  await assert.rejects(engine.install(f.root, f), /GENERATION_INSTALL_BUSY/);
  resume();
  await assert.rejects(first, /network unavailable/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "tools/generation")), []);
});
test("recursive cleanup containment never allows deleting the root or parent", () => {
  const root = path.resolve("tools/generation");
  assert.equal(engine.contained(root, path.join(root, ".install-test")), true);
  for (const bad of [root, path.dirname(root), path.resolve(root, "../outside")])
    assert.equal(engine.contained(root, bad), false);
});
test("Mac binaries requiring macOS 26 are not offered on an older system", async t => {
  const f = fixture(t), build = engine.selectBuild("darwin", "arm64");
  assert.equal(engine.macOSSupported(build, "15.7"), false);
  assert.equal(engine.macOSSupported(build, "26.0"), true);
  assert.equal(engine.macOSSupported(build, "26.1"), true);
  assert.equal(engine.macOSSupported(build, undefined), false);
  const result = engine.readiness({}, build, () => true, "15.7");
  assert.equal(result.supported, false);
  assert.match(result.message, /26\.0/);
  await assert.rejects(engine.install(f.root, { build, platform: "darwin", macOSVersion: "15.7" }), /GENERATION_MACOS_VERSION/);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
