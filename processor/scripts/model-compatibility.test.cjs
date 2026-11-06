const test = require("node:test");
const assert = require("node:assert/strict");
const { assess } = require("../../panel/model-compatibility.js");
const GiB = 1024 ** 3;
const model = { purpose: "GENERATION", os: ["windows", "darwin"], architectures: ["amd64", "arm64"],
  accelerators: ["cuda", "metal"], minimumRamBytes: 16 * GiB, minimumVramBytes: 12 * GiB };
const windows = { os: "windows", architecture: "amd64", memoryBytes: 32 * GiB,
  accelerator: "cuda", vramTotalBytes: 16 * GiB, freeMemoryBytes: 24 * GiB, freeVramBytes: 14 * GiB };
test("total GPU memory determines fit; temporary pressure does not change hardware compatibility", () => {
  assert.equal(assess(model, windows).level, "ok");
  assert.equal(assess(model, { ...windows, freeVramBytes: 2 * GiB }).level, "wait");
  assert.equal(assess(model, { ...windows, vramTotalBytes: 8 * GiB }).level, "no");
  assert.equal(assess(model, windows).level, "ok");
});
test("Apple Silicon uses unified memory without requiring separate VRAM", () => {
  const mac = { ...windows, os: "darwin", architecture: "arm64", accelerator: "metal", vramTotalBytes: null, freeVramBytes: null };
  assert.equal(assess(model, mac).level, "ok");
  assert.equal(assess(model, { ...mac, freeMemoryBytes: 8 * GiB }).level, "wait");
});
test("unknown hardware, offline devices and unverified requirements never claim confirmed fit", () => {
  for (const env of [null, {}, { ...windows, online: false }, { ...windows, accelerator: "unknown" }, { ...windows, vramTotalBytes: null }])
    assert.equal(assess(model, env).level, "unknown");
  assert.equal(assess({ ...model, memoryRequirementsVerified: false }, windows).level, "unknown");
  assert.equal(assess({ ...model, memoryRequirementsVerified: false }, { ...windows, vramTotalBytes: 8 * GiB }).label, "Ниже ориентира");
});
test("CPU-capable models do not require a GPU; unsupported platforms are rejected", () => {
  assert.equal(assess({ ...model, accelerators: ["cpu"] }, { ...windows, accelerator: "unknown", vramTotalBytes: null }).level, "ok");
  assert.equal(assess(model, { ...windows, os: "linux" }).level, "no");
});
