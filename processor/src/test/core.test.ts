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
  parseWhisperJson,
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
      map: {
        ru: { "Hello from catalog test.": "Привет из проверки каталога." },
      },
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
  const report = doctor() as {
    ok: boolean;
    nodeOk: boolean;
    platformOk: boolean;
  };
  assert.equal(report.nodeOk, true);
  assert.equal(report.platformOk, true);
});

test("Whisper JSON preserves detected language and real timestamps", () => {
  const output = parseWhisperJson({
    result: { language: "ru" },
    transcription: [{ text: " Привет ", offsets: { from: 1250, to: 3750 } }],
  });
  assert.equal(output.language, "ru");
  assert.deepEqual(output.cues, [{ start: 1.25, end: 3.75, text: "Привет" }]);
  assert.throws(
    () => parseWhisperJson({ transcription: [] }),
    /LANGUAGE_DETECTION_FAILED/,
  );
  assert.throws(
    () =>
      parseWhisperJson({
        result: { language: "ru" },
        transcription: [{ text: "x", offsets: { from: -1, to: 1 } }],
      }),
    /INVALID_TRANSCRIPT_TIMESTAMPS/,
  );
});
test("renewals during source download start the job exactly once", async () => {
  const { Agent } = await import("../agent.js");
  const fence = {
    assignmentId: randomUUID(),
    generation: 1,
    dispatcherEpoch: randomUUID(),
  };
  const jobId = randomUUID(),
    lease = new LeaseClock();
  const running: any = {
    attempt: { jobId, fence, started: false },
    lease,
    ending: false,
  };
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    session: true,
    config: { testExecutor: false },
    safety: 5,
    running: new Map([[fence.assignmentId, running]]),
    journal: { save() {} },
  });
  let starts = 0;
  agent.startJob = () => {
    starts++;
  };
  for (let i = 0; i < 3; i++) {
    const renewalId = randomUUID();
    lease.sent(renewalId);
    await agent.receive({
      protocolVersion: "2.0",
      messageId: randomUUID(),
      type: "lease.granted",
      body: {
        jobId,
        fence,
        renewalId,
        leaseSeconds: 120,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      },
    });
  }
  assert.equal(starts, 1);
});
test("model redirects work and failed reinstall preserves the installed payload", async (t) => {
  const { installModel, deleteModel } = await import("../models.js");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "model-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let bad = false;
  const payload = Buffer.from("verified-model");
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/payload" });
      res.end();
    } else {
      res.end(bad ? Buffer.from("invalid-model!") : payload);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const entry: any = {
    id: "test-model",
    revision: "1",
    executor: "catalog-test",
    purpose: "RECOGNITION",
    recognitionLanguages: ["en"],
    translationDirections: [],
    minimumRamBytes: 1,
    downloadBytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    downloadUrl: `http://127.0.0.1:${(server.address() as any).port}/redirect`,
  };
  const journal = new Journal(join(dir, "state"));
  const installed = await installModel(
    dir,
    journal,
    [entry],
    entry.id,
    entry.revision,
    100000000,
    () => {},
  );
  bad = true;
  await assert.rejects(
    installModel(
      dir,
      journal,
      [entry],
      entry.id,
      entry.revision,
      100000000,
      () => {},
    ),
    /MODEL_(HASH|SIZE)_MISMATCH/,
  );
  assert.equal(readFileSync(installed.path, "utf8"), payload.toString());
  assert.equal(journal.state.models.length, 1);
  assert.throws(
    () => deleteModel(dir, journal, "..", "1", false),
    /MODEL_ID_INVALID/,
  );
});

test("HLS input accepts local declared parts and rejects network references", async (t) => {
  const { validateHlsInput } = await import("../hls-input.js");
  const dir = mkdtempSync(join(tmpdir(), "hls-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "index.m3u8"),
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n",
  );
  writeFileSync(
    join(dir, "media.m3u8"),
    "#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n",
  );
  assert.equal(
    validateHlsInput(dir, ["index.m3u8", "media.m3u8", "seg.ts"]),
    join(dir, "index.m3u8"),
  );
  writeFileSync(
    join(dir, "media.m3u8"),
    "#EXTM3U\nhttps://example.org/seg.ts\n",
  );
  assert.throws(
    () => validateHlsInput(dir, ["index.m3u8", "media.m3u8", "seg.ts"]),
    /EXTERNAL_HLS_REFERENCE/,
  );
  writeFileSync(join(dir, "media.m3u8"), "#EXTM3U\n../outside.ts\n");
  assert.throws(
    () => validateHlsInput(dir, ["index.m3u8", "media.m3u8", "seg.ts"]),
    /UNDECLARED_HLS_REFERENCE/,
  );
});

test("source download stops at declared size and aborts promptly", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "transfer-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    if (req.url === "/large") {
      res.end(Buffer.alloc(65536));
      return;
    }
    res.writeHead(200);
    res.write("x");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as any).port;
  const link: any = {
    path: "source",
    objectName: "source",
    method: "GET",
    headers: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    url: `http://127.0.0.1:${port}/large`,
  };
  await assert.rejects(
    downloadLink(link, join(dir, "large.bin"), 100, undefined, [0]),
    /declared size/,
  );
  const controller = new AbortController();
  const pending = downloadLink(
    { ...link, url: `http://127.0.0.1:${port}/slow` },
    join(dir, "slow.bin"),
    100,
    undefined,
    [0],
    undefined,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (e) => (e as Error).name === "AbortError");
});

test(
  "speech watchdog stops blocked inference while agent timers keep running",
  { timeout: 8000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "speech-watchdog-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pack = join(dir, "pack.json");
    writeFileSync(
      pack,
      JSON.stringify({ language: "en", text: "hello", delayMs: 5000 }),
    );
    const lease = new LeaseClock();
    lease.sent("speech");
    lease.grant("speech", 2, 1);
    let results = 0,
      ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    t.after(() => clearInterval(timer));
    const executor = new Executor(
      0,
      lease,
      (m) => {
        if (m.type === "speech-result") results++;
      },
      new URL("../speech-child.js", import.meta.url),
      {
        operation: "recognize",
        model: { executor: "catalog-test", path: pack },
        source: pack,
        requested: "auto",
      },
    );
    t.after(() => executor.stop());
    await Promise.race([
      executor.closed,
      delay(4000).then(() => {
        throw new Error("SPEECH_WATCHDOG_FAILED");
      }),
    ]);
    assert.equal(results, 0);
    assert.ok(ticks > 10);
  },
);

test("resource thresholds remain independent", () => {
  const c = {
    maxParallel: 2,
    reserveMemoryBytes: 0,
    taskMemoryBytes: 1,
    threshold: 80,
    cpuThresholdPercent: 70,
    memoryThresholdPercent: 50,
    diskThresholdPercent: 80,
    paused: false,
  } as Config;
  assert.equal(slotBudget(c, 100, 40, 60, 60, "NORMAL", true), 2);
  assert.equal(slotBudget(c, 100, 50, 20, 20, "NORMAL", true), 0);
  assert.equal(slotBudget(c, 100, 20, 70, 20, "NORMAL", true), 0);
});
test("confirmed device settings survive restart without overriding the local work folder", async (t) => {
  const { Agent } = await import("../agent.js");
  const dir = mkdtempSync(join(tmpdir(), "persisted-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, "work");
  mkdirSync(work);
  const journal = new Journal(join(dir, "state"));
  journal.state.appliedSettings = {
    workDirectory: work,
    paused: true,
    autostart: false,
    maxParallel: 1,
    cpuThresholdPercent: 70,
    memoryThresholdPercent: 60,
    diskThresholdPercent: 80,
  };
  journal.save();
  const config = {
    url: "ws://127.0.0.1:1/api/v2/device/connect",
    deviceId: randomUUID(),
    stateDir: join(dir, "state"),
    workDir: dir,
    maxParallel: 4,
    reserveMemoryBytes: 0,
    taskMemoryBytes: 1,
    reserveDiskBytes: 0,
    threshold: 80,
    paused: false,
    testExecutor: true,
    testDurationMs: 1000,
    ffmpeg: "not-a-binary",
    ffprobe: "not-a-binary",
  } as Config;
  const agent = new Agent(
    config,
    "test",
    new Journal(join(dir, "state")),
    () => {},
  );
  assert.equal(agent.config.workDir, dir);
  assert.equal(agent.config.paused, true);
  assert.equal(agent.config.maxParallel, 1);
  assert.equal(agent.config.memoryThresholdPercent, 60);
  const startupCalls: boolean[] = [];
  agent.config.desktopAutostart = async (enabled) => { startupCalls.push(enabled); };
  agent.journal.state.autostart = true;
  for (const extra of [{}, { workDirectory: join(dir, "remote-must-not-create") }]) {
    await agent.runCommand({
      requestId: randomUUID(), type: "CONFIGURE",
      settings: { ...extra, paused: false, autostart: false, maxParallel: 3,
        cpuThresholdPercent: 65, memoryThresholdPercent: 55, diskThresholdPercent: 75 },
    } as any);
    assert.equal(agent.config.workDir, dir);
    assert.equal(agent.config.maxParallel, 3);
    assert.equal(agent.config.cpuThresholdPercent, 65);
    assert.equal(agent.config.paused, false);
    assert.equal(agent.journal.state.autostart, true);
    assert.deepEqual(startupCalls, []);
    assert.equal("autostart" in (agent.journal.state.appliedSettings || {}), false);
    assert.equal("workDirectory" in (agent.journal.state.appliedSettings || {}), false);
  }
  await agent.close();
});

test("system failures always become valid public error codes", async () => {
  const { errorCode } = await import("../errors.js");
  assert.equal(
    errorCode(
      Object.assign(new Error("ENOENT: private/path"), { code: "ENOENT" }),
      "JOB_FAILED",
    ),
    "FILE_NOT_FOUND",
  );
  assert.equal(
    errorCode(
      new Error("native executor failed with stack/path"),
      "JOB_FAILED",
    ),
    "JOB_FAILED",
  );
  assert.equal(
    errorCode(new Error("MODEL_NOT_INSTALLED"), "JOB_FAILED"),
    "MODEL_NOT_INSTALLED",
  );
});
