import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { bundledCatalog, type ModelEntry } from "../catalog.js";
import { sha256Canonical } from "../jcs.js";
import { Journal } from "../journal.js";
import { installModel, activateModel, modelReady } from "../models.js";
import { parseNvidiaMemory } from "../resources.js";

test("generation packages include pinned complete manifests and verified download sizes", () => {
  const entries = bundledCatalog.filter(m => m.purpose === "GENERATION");
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.slice(0, 2).map(m => m.executor), ["stable-diffusion.cpp", "stable-diffusion.cpp"]);
  for (const entry of entries) {
    assert.equal(entry.memoryRequirementsVerified, false);
    assert.ok(entry.files && entry.files.length <= 32);
    assert.equal(sha256Canonical(entry.files), entry.sha256);
    assert.equal(entry.files.reduce((n, f) => n + f.bytes, 0), entry.downloadBytes);
    for (const prefix of (entry.executor === "stable-diffusion.cpp" ? ["text_encoder/", "transformer/", "vae/"] : ["text_encoder/", "tokenizer/", "transformer/", "vae/"]))
      assert.ok(entry.files.some(f => f.path.startsWith(prefix)));
    for (const file of entry.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.match(file.url, /\/resolve\/[a-f0-9]{40}\//);
    }
  }
});

test("NVIDIA name and memory describe one adapter, never a sum or integrated GPU", () => {
  assert.deepEqual(parseNvidiaMemory("NVIDIA RTX 5060 Ti, 16384, 1024\nNVIDIA Other, 8192, 4096"),
    { name: "NVIDIA RTX 5060 Ti", totalBytes: 16384 * 1024 ** 2, usedBytes: 1024 ** 3 });
  for (const bad of ["", "GPU, N/A, N/A", "GPU, 0, 0", "GPU, 10, 20", "GPU, -1, 0"])
    assert.equal(parseNvidiaMemory(bad), null);
});

test("generation packages can be installed and verified without falsely enabling generation", async t => {
  const dir = mkdtempSync(join(tmpdir(), "generation-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payload = Buffer.from("test-generation-weights");
  let corrupt = false;
  const server = createServer((req, res) => res.end(corrupt ? Buffer.alloc(payload.length) : payload));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/weights`;
  const files = [{ path: "transformer/weights.safetensors", bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"), url }];
  const entry: ModelEntry = { ...bundledCatalog.find(m => m.purpose === "GENERATION")!,
    id: "test-generation", revision: "test-1", downloadUrl: url, files,
    downloadBytes: payload.length, sha256: sha256Canonical(files) };
  const journal = new Journal(join(dir, "state"));
  const installed = await installModel(dir, journal, [entry], entry.id, entry.revision, 1024 ** 3, () => {});
  assert.equal(installed.state, "INSTALLED");
  assert.equal(modelReady(installed), false);
  assert.throws(() => activateModel(journal, entry.id, entry.revision), /EXECUTOR_UNAVAILABLE/);
  corrupt = true;
  await assert.rejects(installModel(dir, journal, [entry], entry.id, entry.revision, 1024 ** 3, () => {}), /MODEL_HASH_MISMATCH/);
  assert.deepEqual(readFileSync(join(installed.path, files[0].path)), payload);
  assert.equal(journal.state.models[0].path, installed.path);
});
