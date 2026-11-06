import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { Agent } from "../agent.js";
import { Journal, type InstalledModel } from "../journal.js";
import type { Config } from "../config.js";
import { Executor } from "../executor.js";
import { LeaseClock } from "../lease.js";
import { generationProfile, generationDevice } from "../generation.js";

test("generation executes a native child, uploads a PNG and awaits publication without a fictitious source", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "generation-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = join(root, process.platform === "win32" ? "engine.exe" : "engine");
  execFileSync("go", ["build", "-o", engine, fileURLToPath(new URL("../../src/test/fixtures/generation-engine.go", import.meta.url))], { windowsHide: true });
  assert.equal(generationDevice(engine, "cpu"), "CPU");
  assert.match(generationDevice(engine, "gpu")!, /CUDA0|Metal0/);
  process.env.GENERATION_FIXTURE_CPU_ONLY = "1";
  try {
    assert.equal(generationDevice(engine, "auto"), "CPU");
    assert.equal(generationDevice(engine, "gpu"), null);
  } finally { delete process.env.GENERATION_FIXTURE_CPU_ONLY; }
  const modelPath = join(root, "model");
  for (const file of ["transformer/model.gguf", "text_encoder/model.gguf", "vae/model.safetensors"]) {
    mkdirSync(join(modelPath, file, ".."), { recursive: true }); writeFileSync(join(modelPath, file), "fixture");
  }
  const model: InstalledModel = { id: "flux2-klein-4b-q4", revision: "test-weights", executor: "stable-diffusion.cpp", purpose: "GENERATION",
    state: "ACTIVE", path: modelPath, recognitionLanguages: [], translationDirections: [], minimumRamBytes: 0 };
  const profile = generationProfile(model)!;
  const journal = new Journal(join(root, "state")); journal.state.models.push(model); journal.save();
  const config = { url: "ws://127.0.0.1:1/api/v2/device/connect", deviceId: randomUUID(), stateDir: join(root, "state"), workDir: root,
    maxParallel: 1, reserveMemoryBytes: 0, taskMemoryBytes: 1, reserveDiskBytes: 0, threshold: 80,
    paused: false, testExecutor: false, testDurationMs: 1000, ffmpeg: "not-installed", ffprobe: "not-installed", stableDiffusion: engine } as Config;
  const agent = new Agent(config, "fixture", journal, () => {});
  t.after(() => agent.close());
  assert.ok(agent.caps().some(c => c.code === "media.generate" && c.generationModels[0].id === model.id));
  let uploaded = Buffer.alloc(0);
  const reference = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
  const server = createServer((req, res) => {
    if (req.method === "GET") { res.end(reference); return; }
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => { uploaded = Buffer.concat(chunks); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const frames: any[] = [];
  (agent as any).durable = async (_running: any, frame: any) => { frames.push(frame); };
  (agent as any).transfer = async (path: string, method: string, running: any, action: any) => action({ path, method, objectName: path,
    url: `http://127.0.0.1:${(server.address() as any).port}/file`, headers: {}, expiresAt: new Date(Date.now() + 60000).toISOString() });
  for (const mode of ["gpu", "cpu"] as const) {
   for (const withReference of [false, true]) {
    frames.length = 0; uploaded = Buffer.alloc(0);
    const lease = new LeaseClock(); lease.sent("initial"); lease.grant("initial", 120, 5);
    const job: any = { id: randomUUID(), type: "media.generate", maxOutputBytes: 1024 ** 2, maxDurationSeconds: 30,
      params: { modelId: model.id, modelRevision: model.revision, profileRevision: profile.profileRevision,
        inputs: { prompt: mode === "cpu" ? "cpu-settings-test" : "A forest; $(not-a-command)", width: 512, height: 512, seed: 10 } } };
    if (withReference) job.source = { kind: "FILE", bytes: reference.length, sha256: createHash("sha256").update(reference).digest("hex") };
    const running: any = { job, lease, processing: { generationMode: mode, cpuThreads: 4, maxParallel: 2 }, ending: false, progress: 0, activity: 0, grants: [], acks: new Set(), transferAbort: new AbortController(),
      attempt: { jobId: job.id, fence: { assignmentId: randomUUID(), generation: 1, dispatcherEpoch: randomUUID() }, started: true } };
    journal.state.attempts.push(running.attempt); agent.running.set(running.attempt.fence.assignmentId, running);
    await agent.runJob(running);
    assert.equal(frames.some(f => f.type === "job.source.request"), withReference);
    const artifact = frames.find(f => f.type === "job.artifact.propose").body.artifact;
    assert.equal(artifact.manifest.files[0].kind, "IMAGE");
    assert.equal(artifact.manifest.files[0].sha256, createHash("sha256").update(uploaded).digest("hex"));
    assert.equal(uploaded.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(running.attempt.awaitingPublication, true);
    assert.ok(frames.some(f => f.type === "job.upload.complete"));
    assert.equal(agent.running.size, 0);
   }
  }
  const lease = new LeaseClock(); lease.sent("expiry"); lease.grant("expiry", 3, 0);
  const cancelDir = join(root, "cancel-test");
  const executor = new Executor(30000, lease, () => {}, new URL("../generation-child.js", import.meta.url), {
    executable: engine, device: "CUDA0", modelPath, inputs: { prompt: "wait-for-cancel", width: 512, height: 512 },
    steps: 4, outDir: cancelDir, maxOutputBytes: 1024 ** 2, reserveDiskBytes: 0, maxDurationSeconds: 30,
  });
  t.after(() => executor.stop());
  await new Promise(resolve => setTimeout(resolve, 500));
  const nativePid = Number(readFileSync(join(cancelDir, "image.png.pid"), "utf8"));
  await Promise.race([executor.closed, new Promise((_, reject) => setTimeout(() => reject(Error("Generation watchdog did not stop")), 6000))]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(nativePid, 0));

  const manualLease = new LeaseClock(); manualLease.sent("manual"); manualLease.grant("manual", 120, 5);
  const manualDir = join(root, "manual-stop");
  const manual = new Executor(30000, manualLease, () => {}, new URL("../generation-child.js", import.meta.url), {
    executable: engine, device: "CUDA0", modelPath, inputs: { prompt: "wait-for-cancel", width: 512, height: 512 },
    steps: 4, outDir: manualDir, maxOutputBytes: 1024 ** 2, reserveDiskBytes: 0, maxDurationSeconds: 30,
  });
  t.after(() => manual.stop());
  await new Promise(resolve => setTimeout(resolve, 500));
  const manualPid = Number(readFileSync(join(manualDir, "image.png.pid"), "utf8"));
  await manual.stop();
  assert.throws(() => process.kill(manualPid, 0));

});
