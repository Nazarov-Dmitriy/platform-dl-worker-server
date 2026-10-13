import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { LeaseClock } from "../lease.js";
import { Journal } from "../journal.js";
import { Resources, slotBudget } from "../resources.js";
import { frame, parseFrame } from "../protocol.js";
import { Executor } from "../executor.js";
import { lockInstance } from "../instance.js";
import { decidePlan, type Probe, type Profile } from "../packaging.js";
import { cleanupWork, createAttemptDir, utcDate } from "../files.js";
import { downloadLink, TransferError, uploadLink } from "../transfer.js";
import type { Config } from "../config.js";
import { whisperLanguages } from "../catalog.js";
import {
  cuesToVtt,
  selectRecognition,
  transcribeSource,
  translateCues,
} from "../speech.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("lost and delayed grants never start or revive expired rights", () => {
  let mono = 0,
    wall = 100000;
  const lease = new LeaseClock({ mono: () => mono, wall: () => wall });
  assert.equal(lease.grant("unknown", 120, 5), false);
  lease.sent("accept");
  mono = 10000;
  wall += 10000;
  assert.equal(lease.grant("accept", 120, 5), true);
  assert.equal(lease.remaining(), 105000);
  mono = 115001;
  wall = 215001;
  assert.equal(lease.valid(), false);
  lease.sent("late");
  assert.equal(lease.grant("late", 120, 5), false);
});
test("sleep and backward wall-clock jumps stop executors conservatively", () => {
  let mono = 0,
    wall = 100000;
  const lease = new LeaseClock({ mono: () => mono, wall: () => wall });
  lease.sent("x");
  lease.grant("x", 120, 5);
  wall += 120000;
  assert.equal(lease.valid(), false);
  const other = new LeaseClock({ mono: () => mono, wall: () => wall });
  other.sent("x");
  other.grant("x", 120, 5);
  wall -= 5000;
  assert.equal(other.valid(), false);
});
test("retransmitted accept preserves original send deadline", () => {
  let mono = 0,
    wall = 100000;
  const lease = new LeaseClock({ mono: () => mono, wall: () => wall });
  lease.sent("same");
  mono = 114000;
  wall += 114000;
  lease.sent("same");
  assert.equal(lease.grant("same", 120, 5), true);
  assert.equal(lease.remaining(), 1000);
});
test("journal persists attempts and outgoing confirmations atomically", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "processor-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const j = new Journal(dir);
  const fence = {
    assignmentId: randomUUID(),
    generation: 1,
    dispatcherEpoch: randomUUID(),
  };
  const accept = frame("job.accept", { jobId: randomUUID(), fence });
  j.state.attempts.push({
    jobId: accept.body.jobId,
    fence,
    accept,
    started: true,
  });
  j.state.outbox.push(frame("job.stopped", accept.body));
  j.save();
  assert.deepEqual(new Journal(dir).state, j.state);
  assert.throws(() => parseFrame(JSON.stringify(accept), "DOWN"));
});
test("threshold, pressure and memory reservations restrict admission", () => {
  const c = {
    maxParallel: 4,
    reserveMemoryBytes: 2,
    taskMemoryBytes: 2,
    paused: false,
    threshold: 80,
  } as Config;
  assert.equal(slotBudget(c, 10, 20, 20, 20, "NORMAL", true), 4);
  for (const args of [
    [10, 20, 80, 20, "NORMAL", true],
    [10, 80, 20, 20, "NORMAL", true],
    [10, 20, 20, 80, "NORMAL", true],
    [10, 20, 20, 20, "CRITICAL", true],
    [10, 20, 20, 20, "NORMAL", false],
    [3, 20, 20, 20, "NORMAL", true],
  ] as const)
    assert.equal(
      slotBudget(c, args[0], args[1], args[2], args[3], args[4], args[5]),
      0,
    );
});
test("missing or replaced work directory never redirects work to another disk", (t) => {
  const root = mkdtempSync(join(tmpdir(), "processor-volume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  mkdirSync(work);
  const c = {
    workDir: work,
    reserveDiskBytes: 0,
    reserveMemoryBytes: 0,
    taskMemoryBytes: 1,
    maxParallel: 1,
    threshold: 80,
    paused: false,
  } as Config;
  const resources = new Resources(c, new Journal(join(root, "state")));
  assert.equal(resources.sample().workDiskAvailable, true);
  renameSync(work, join(root, "old"));
  mkdirSync(work);
  assert.equal(resources.sample().workDiskAvailable, false);
  assert.throws(
    () =>
      new Resources(
        { ...c, workDir: join(root, "missing") },
        new Journal(join(root, "other")),
      ),
  );
});
test("exclusive processor writer lock is released after shutdown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "processor-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = await lockInstance(dir);
  await assert.rejects(lockInstance(dir), /INSTANCE_LOCKED/);
  release();
  await delay(30);
  const again = await lockInstance(dir);
  again();
});
test("independent watchdog exits while parent event loop is blocked", async () => {
  const lease = new LeaseClock();
  lease.sent("x");
  lease.grant("x", 10, 9);
  const executor = new Executor(60000, lease, () => {});
  await delay(200);
  const end = Date.now() + 1600;
  while (Date.now() < end) {}
  await Promise.race([
    executor.closed,
    delay(1000).then(() => {
      throw new Error("Watchdog did not exit");
    }),
  ]);
  assert.ok(
    executor.child.exitCode !== null || executor.child.signalCode !== null,
  );
});
test("owned executor can be stopped without saved-PID process killing", async () => {
  const lease = new LeaseClock();
  lease.sent("x");
  lease.grant("x", 120, 5);
  const executor = new Executor(60000, lease, () => {});
  await delay(150);
  await executor.stop();
  assert.equal(executor.stopped, true);
});
test("executor stops after its owner crashes and IPC disconnects", async () => {
  const owner = fork(
    fileURLToPath(new URL("./executor-owner.js", import.meta.url)),
    [],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const pid = await new Promise<number>((resolve, reject) => {
    owner.once("message", (m: any) => resolve(m.pid));
    owner.once("error", reject);
  });
  await delay(300);
  owner.kill();
  const end = Date.now() + 4000;
  let alive = true;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
      if (
        process.platform === "linux" &&
        /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
      ) {
        alive = false;
        break;
      }
    } catch {
      alive = false;
      break;
    }
    await delay(50);
  }
  assert.equal(alive, false, "Executor survived owner crash");
});
const profile: Profile = {
  policyVersion: "site-hls-2026-10-01",
  qualities: ["P720", "P1080"],
  segmentDurationSeconds: 6,
  codec: "h264",
  encoderPolicy: "X264_EXACT",
  preset: "slow",
  crf: 25,
  audioBitrateKbps: 96,
  audioChannels: 1,
  targetVideoBitrateKbps: { P480: 700, P720: 1200, P1080: 2500 },
  passthroughTolerancePercent: 20,
  allowUpscale: false,
};
test("low-resolution source keeps one actual rendition and never upscales", () => {
  const probe: Probe = {
    duration: 2,
    width: 320,
    height: 240,
    videoCodec: "h264",
    pixFmt: "yuv420p",
    profile: "High",
    fps: 30,
    cfr: true,
    rotate: 0,
    videoBitrate: 400000,
    audioCodec: "aac",
    audioChannels: 1,
    audioBitrate: 96000,
  };
  const plan = decidePlan(probe, profile);
  assert.equal(plan.length, 1);
  assert.ok(plan[0].height <= 240);
  assert.equal(plan[0].mode, "COPY");
});
test("compatible 720p source copies without re-encoding", () => {
  const probe: Probe = {
    duration: 2,
    width: 1280,
    height: 720,
    videoCodec: "h264",
    pixFmt: "yuv420p",
    profile: "High",
    fps: 30,
    cfr: true,
    rotate: 0,
    videoBitrate: 1000000,
    audioCodec: "aac",
    audioChannels: 1,
    audioBitrate: 96000,
  };
  const plan = decidePlan(probe, profile);
  const copy = plan.find((p) => p.quality === "P720");
  assert.equal(copy?.mode, "COPY");
  assert.equal(
    plan.find((p) => p.quality === "P1080"),
    undefined,
  );
});
test("work cleanup keeps active and unpublished attempts across date folders", (t) => {
  const root = mkdtempSync(join(tmpdir(), "processor-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = new Journal(join(root, "state"));
  const work = join(root, "work");
  mkdirSync(work);
  new Resources(
    {
      workDir: work,
      reserveDiskBytes: 0,
      reserveMemoryBytes: 0,
      taskMemoryBytes: 1,
      maxParallel: 1,
      threshold: 80,
      paused: false,
    } as Config,
    journal,
  );
  const keepDir = createAttemptDir(work, "keep-me", journal);
  const gone = join(work, "files", "1999-01-01", "old");
  mkdirSync(gone, { recursive: true });
  cleanupWork(work, new Set([keepDir]));
  assert.equal(existsSync(keepDir), true);
  assert.equal(existsSync(gone), false);
  assert.ok(utcDate().length === 10);
});
test("expired storage URLs refresh instead of rewriting the package", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "processor-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as any).port;
  const dest = join(dir, "out.bin");
  await assert.rejects(
    () =>
      downloadLink(
        {
          path: "source",
          objectName: "x",
          url: `http://127.0.0.1:${port}/a`,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          method: "GET",
          headers: {},
        },
        dest,
        undefined,
        undefined,
        [0],
      ),
    (e: unknown) => e instanceof TransferError && e.refresh,
  );
});
test("recognition languages come from the Whisper tokenizer list", () => {
  assert.ok(whisperLanguages.includes("yue"));
  assert.ok(whisperLanguages.includes("uk"));
  assert.ok(whisperLanguages.length > 90);
  assert.equal(new Set(whisperLanguages).size, whisperLanguages.length);
});
test("catalog-test speech returns original text without translation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "speech-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pack = join(dir, "pack.json");
  const source = join(dir, "source.json");
  writeFileSync(
    pack,
    JSON.stringify({
      language: "en",
      text: "Hello from catalog test.",
      cues: [{ start: 0, end: 1, text: "Hello from catalog test." }],
      failTargets: ["uk"],
      map: { ru: { "Hello from catalog test.": "Привет из проверки каталога." } },
    }),
  );
  writeFileSync(
    source,
    JSON.stringify({
      language: "en",
      text: "Hello from catalog test.",
      cues: [{ start: 0, end: 1, text: "Hello from catalog test." }],
    }),
  );
  const model = {
    id: "catalog-test-speech",
    revision: "test-1",
    state: "ACTIVE" as const,
    path: pack,
    purpose: "RECOGNITION" as const,
    executor: "catalog-test",
    recognitionLanguages: whisperLanguages,
    translationDirections: [],
    minimumRamBytes: 1,
  };
  const picked = selectRecognition([model], "FAST", 1024);
  const out = transcribeSource(source, picked, "auto");
  assert.equal(out.language, "en");
  assert.equal(out.text, "Hello from catalog test.");
  assert.equal(out.text.includes("Привет"), false);
  assert.match(cuesToVtt(out.cues), /WEBVTT/);
  const ru = translateCues(out.cues, "en", "ru", {
    ...model,
    purpose: "TRANSLATION",
    path: pack,
  });
  assert.equal(ru[0].text, "Привет из проверки каталога.");
  assert.throws(
    () =>
      translateCues(out.cues, "en", "uk", {
        ...model,
        purpose: "TRANSLATION",
        path: pack,
      }),
    /TRANSLATION_UNAVAILABLE/,
  );
});
test("doctor reports node and platform without requiring a token", async () => {
  const { doctor } = await import("../doctor.js");
  const report = doctor() as { ok: boolean; nodeOk: boolean; platformOk: boolean };
  assert.equal(report.nodeOk, true);
  assert.equal(report.platformOk, true);
});
