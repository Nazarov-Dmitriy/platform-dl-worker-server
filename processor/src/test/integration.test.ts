import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Agent } from "../agent.js";
import { Journal } from "../journal.js";
import type { Config } from "../config.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("Integration condition timed out");
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
const executable = process.env.E2E_DISPATCHER;
test(
  "two Node processors against real Go dispatcher: reconnect, cancel and lease loss",
  { skip: !executable, timeout: 45000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "processor-e2e-"));
    const db = join(root, "dispatcher.db");
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(executable!, [...args, "-db", db], {
          encoding: "utf8",
          windowsHide: true,
        }),
      );
    const site = cli("site-create", "-name", "test");
    const siteToken = cli(
      "token-issue",
      "-purpose",
      "SITE",
      "-id",
      site.id,
    ).token;
    const devices = [0, 1].map((i) => {
      const d = cli("device-create", "-name", "test" + i);
      return {
        ...d,
        token: cli("token-issue", "-purpose", "DEVICE", "-id", d.id).token,
      };
    });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const server = spawn(
      executable!,
      [
        "serve",
        "-db",
        db,
        "-listen",
        `127.0.0.1:${port}`,
        "-lease",
        "10s",
        "-heartbeat",
        "1s",
        "-stop-safety",
        "1s",
        "-admission-stable",
        "0s",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const agents: Agent[] = [];
    t.after(async () => {
      await Promise.all(agents.map((a) => a.close()));
      server.kill();
      await delay(300);
      rmSync(root, { recursive: true, force: true });
    });
    await until(async () => {
      try {
        return (await fetch(base + "/healthz")).ok;
      } catch {
        return false;
      }
    });
    const usage = {
      cpuPercent: 10,
      memoryUsedPercent: 20,
      memoryPressure: "NORMAL",
      diskUsedPercent: 10,
      freeMemoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3,
      freeVramBytes: null,
      encoderBusyPercent: null,
      availableSlots: 1,
      paused: false,
      workDiskAvailable: true,
    };
    for (const d of devices) {
      const work = join(root, d.id);
      mkdirSync(work);
      const config: Config = {
        url: base.replace("http:", "ws:") + "/api/v2/device/connect",
        deviceId: d.id,
        stateDir: join(work, "state"),
        workDir: work,
        maxParallel: 1,
        reserveMemoryBytes: 0,
        taskMemoryBytes: 1,
        reserveDiskBytes: 0,
        threshold: 80,
        paused: false,
        testExecutor: true,
        testDurationMs: 60000,
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
      };
      const agent = new Agent(
        config,
        d.token,
        new Journal(config.stateDir),
        () => {},
      );
      agent.resources.sample = () => ({ ...usage });
      agents.push(agent);
      agent.start();
    }
    await until(() => agents.every((a) => a.session));
    const headers = {
      Authorization: `Bearer ${siteToken}`,
      "Content-Type": "application/json",
    };
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../contracts/fixtures/valid/job-video.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ).value;
    const submit = async () => {
      const job = { ...fixture, id: randomUUID() };
      const resp = await fetch(base + "/api/v2/site/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify(job),
      });
      assert.equal(resp.status, 202);
      return job.id;
    };
    const view = async (id: string) =>
      (
        await fetch(base + "/api/v2/site/jobs/" + id, { headers })
      ).json() as Promise<any>;
    const first = await submit(),
      second = await submit();
    await until(() =>
      agents.every((a) => [...a.running.values()].some((r) => r.executor)),
    );
    assert.equal(
      agents.reduce((n, a) => n + a.running.size, 0),
      2,
    );
    const owner = agents.find((a) =>
      [...a.running.values()].some((r) => r.attempt.jobId === first),
    )!;
    const original = [...owner.running.values()].find(
      (r) => r.attempt.jobId === first,
    )!;
    const pid = original.executor!.child.pid;
    const oldSocket = owner.socket;
    owner.socket!.terminate();
    await until(
      () =>
        owner.socket !== oldSocket &&
        owner.session &&
        owner.socket?.readyState === 1,
    );
    await delay(300);
    assert.equal(
      [...owner.running.values()].find((r) => r.attempt.jobId === first)!
        .executor!.child.pid,
      pid,
      "Reconnect restarted the executor",
    );
    const cancel = await fetch(base + `/api/v2/site/jobs/${first}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        protocolVersion: "2.0",
        requestId: randomUUID(),
        reason: "test",
      }),
    });
    assert.ok(cancel.ok);
    await until(async () => (await view(first)).status === "CANCELLED");
    assert.equal(owner.running.size, 0);
    // Complete the second isolated test and return a clear permanent error, never READY.
    const other = agents.find((a) =>
      [...a.running.values()].some((r) => r.attempt.jobId === second),
    )!;
    const running = [...other.running.values()][0];
    await other.finish(running, "TEST_EXECUTOR_ONLY");
    await until(async () => (await view(second)).status === "FAILED");
    assert.equal((await view(second)).error.code, "TEST_EXECUTOR_ONLY");
    const third = await submit();
    await until(() =>
      agents.some((a) => [...a.running.values()].some((r) => r.executor)),
    );
    const active = agents
      .flatMap((a) => [...a.running.values()])
      .find((r) => r.attempt.jobId === third)!;
    const executor = active.executor!;
    server.kill();
    await until(() => agents.every((a) => !a.session));
    await until(
      () =>
        executor.child.exitCode !== null || executor.child.signalCode !== null,
      12000,
    );
    await until(() => agents.every((a) => a.running.size === 0));
    assert.ok(
      agents.some((a) =>
        a.journal.state.outbox.some((f) => f.type === "job.failed"),
      ),
      "Disconnected failure was not persisted",
    );
  },
);
function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    execFileSync("ffprobe", ["-version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
test(
  "full FILE transcode downloads, packages, uploads and publishes",
  { skip: !executable || !hasFfmpeg(), timeout: 90000 },
  async (t) => {
    const { createHash } = await import("node:crypto");
    const { createServer } = await import("node:http");
    const { writeFileSync, readFileSync: read } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "processor-video-"));
    const db = join(root, "dispatcher.db");
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(executable!, [...args, "-db", db], {
          encoding: "utf8",
          windowsHide: true,
        }),
      );
    const site = cli("site-create", "-name", "video");
    const siteToken = cli(
      "token-issue",
      "-purpose",
      "SITE",
      "-id",
      site.id,
    ).token;
    const device = cli("device-create", "-name", "ffmpeg");
    const deviceToken = cli(
      "token-issue",
      "-purpose",
      "DEVICE",
      "-id",
      device.id,
    ).token;
    const source = join(root, "source.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1280x720:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-c:a",
        "aac",
        "-ac",
        "1",
        "-b:a",
        "96k",
        "-b:v",
        "1000k",
        source,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const bytes = read(source);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const objects = new Map<string, Buffer>();
    objects.set("uploads/video.mp4", bytes);
    const storage = createServer((req, res) => {
      const key = decodeURIComponent((req.url || "/").slice(1));
      if (req.method === "GET") {
        const body = objects.get(key);
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(body);
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200);
          res.end();
        });
        return;
      }
      res.writeHead(405);
      res.end();
    });
    await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
    const storagePort = (storage.address() as net.AddressInfo).port;
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let agent: Agent | undefined;
    const server = spawn(
      executable!,
      [
        "serve",
        "-db",
        db,
        "-listen",
        `127.0.0.1:${port}`,
        "-lease",
        "60s",
        "-heartbeat",
        "2s",
        "-stop-safety",
        "1s",
        "-admission-stable",
        "0s",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(async () => {
      await agent?.close();
      server.kill();
      storage.close();
      await delay(300);
      rmSync(root, { recursive: true, force: true });
    });
    await until(async () => {
      try {
        return (await fetch(base + "/healthz")).ok;
      } catch {
        return false;
      }
    });
    const work = join(root, "work");
    mkdirSync(work);
    const config: Config = {
      url: base.replace("http:", "ws:") + "/api/v2/device/connect",
      deviceId: device.id,
      stateDir: join(root, "state"),
      workDir: work,
      maxParallel: 1,
      reserveMemoryBytes: 0,
      taskMemoryBytes: 1,
      reserveDiskBytes: 0,
      threshold: 80,
      paused: false,
      testExecutor: false,
      testDurationMs: 3000,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
    };
    agent = new Agent(
      config,
      deviceToken,
      new Journal(config.stateDir),
      () => {},
    );
    agent.resources.sample = () => ({
      cpuPercent: 10,
      memoryUsedPercent: 20,
      memoryPressure: "NORMAL",
      diskUsedPercent: 10,
      freeMemoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3,
      freeVramBytes: null,
      encoderBusyPercent: null,
      availableSlots: 1,
      paused: false,
      workDiskAvailable: true,
    });
    agent.start();
    await until(() => !!agent?.session);
    const headers = {
      Authorization: `Bearer ${siteToken}`,
      "Content-Type": "application/json",
    };
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../contracts/fixtures/valid/job-video.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ).value;
    fixture.id = randomUUID();
    fixture.source.bytes = bytes.length;
    fixture.source.sha256 = sha;
    delete fixture.params.subtitles;
    const submit = await fetch(base + "/api/v2/site/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify(fixture),
    });
    assert.equal(submit.status, 202);
    const objectUrl = (name: string) =>
      `http://127.0.0.1:${storagePort}/` + encodeURIComponent(name);
    await until(async () => {
      const view = await (
        await fetch(base + "/api/v2/site/jobs/" + fixture.id, { headers })
      ).json();
      const transfers = await (
        await fetch(base + "/api/v2/site/jobs/" + fixture.id + "/transfers", {
          headers,
        })
      ).json();
      for (const req of transfers.requests || []) {
        if (req.kind === "SOURCE") {
          await fetch(
            base + "/api/v2/site/jobs/" + fixture.id + "/transfer-grants",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                protocolVersion: "2.0",
                requestId: req.id,
                fence: req.fence,
                links: [
                  {
                    path: "source",
                    objectName: "uploads/video.mp4",
                    url: objectUrl("uploads/video.mp4"),
                    expiresAt: new Date(Date.now() + 3600000).toISOString(),
                    method: "GET",
                    headers: {},
                  },
                ],
                page: 0,
                lastPage: true,
              }),
            },
          );
        }
        if (req.kind === "UPLOAD") {
          const prefix =
            "jobs/" +
            site.id +
            "/" +
            fixture.id +
            "/" +
            req.fence.dispatcherEpoch +
            "/" +
            req.fence.generation +
            "/" +
            req.fence.assignmentId +
            "/";
          await fetch(
            base + "/api/v2/site/jobs/" + fixture.id + "/transfer-grants",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                protocolVersion: "2.0",
                requestId: req.id,
                fence: req.fence,
                links: req.artifact.manifest.files.map((file: any) => ({
                  path: file.path,
                  objectName: prefix + file.path,
                  url: objectUrl(prefix + file.path),
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                  method: "PUT",
                  headers: { "Content-Type": file.contentType },
                })),
                page: 0,
                lastPage: true,
              }),
            },
          );
        }
      }
      if (view.status === "AWAITING_PUBLICATION") {
        const claimId = randomUUID();
        const claim = await fetch(
          base + "/api/v2/site/jobs/" + fixture.id + "/publication-claim",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              protocolVersion: "2.0",
              claimId,
              artifactId: view.artifact.id,
              manifestSha256: view.artifact.manifestSha256,
              fence: view.artifact.fence,
            }),
          },
        );
        assert.equal(claim.status, 200);
        const decision = await fetch(
          base + "/api/v2/site/jobs/" + fixture.id + "/publication-decision",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              protocolVersion: "2.0",
              artifactId: view.artifact.id,
              fence: view.artifact.fence,
              manifestSha256: view.artifact.manifestSha256,
              decision: "PUBLISHED",
              publicationId: randomUUID(),
              claimId,
            }),
          },
        );
        assert.equal(decision.status, 200);
        return true;
      }
      return ["FAILED", "REJECTED"].includes(view.status);
    }, 60000);
    const done = await (
      await fetch(base + "/api/v2/site/jobs/" + fixture.id, { headers })
    ).json();
    assert.equal(done.status, "SUCCEEDED");
    assert.equal(done.artifact.manifest.renditions[0].mode, "COPY");
    assert.ok(
      [...objects.keys()].some((k) => k.endsWith("index.m3u8")),
      "HLS master was not uploaded",
    );
    await until(() => agent!.journal.state.attempts.length === 0, 20000);
    writeFileSync(join(root, "ok"), "1");
  },
);
test(
  "catalog-test transcribe installs, returns original-language text, rejects missing translation",
  { skip: !executable, timeout: 60000 },
  async (t) => {
    const { createHash } = await import("node:crypto");
    const { createServer } = await import("node:http");
    const { writeFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "processor-speech-"));
    const db = join(root, "dispatcher.db");
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(executable!, [...args, "-db", db], {
          encoding: "utf8",
          windowsHide: true,
        }),
      );
    const pack = Buffer.from(
      JSON.stringify({
        language: "en",
        text: "Hello from catalog test.",
        cues: [{ start: 0, end: 1, text: "Hello from catalog test." }],
      }),
      "utf8",
    );
    const source = Buffer.from(
      JSON.stringify({
        language: "en",
        text: "Hello from catalog test.",
        cues: [{ start: 0, end: 1, text: "Hello from catalog test." }],
      }),
      "utf8",
    );
    const objects = new Map<string, Buffer>();
    const storage = createServer((req, res) => {
      const key = decodeURIComponent((req.url || "/").slice(1));
      if (req.method === "GET") {
        const body = objects.get(key);
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(body);
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200);
          res.end();
        });
        return;
      }
      res.writeHead(405);
      res.end();
    });
    await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
    const storagePort = (storage.address() as net.AddressInfo).port;
    objects.set("models/speech.json", pack);
    objects.set("uploads/audio.json", source);
    const modelUrl = `http://127.0.0.1:${storagePort}/models/speech.json`;
    const entry = {
      id: "catalog-test-speech",
      revision: "test-1",
      executor: "catalog-test",
      purpose: "RECOGNITION",
      os: ["windows", "darwin", "linux"],
      architectures: ["amd64", "arm64"],
      accelerators: ["cpu"],
      recognitionLanguages: ["en", "uk", "yue"],
      translationDirections: [],
      downloadBytes: pack.length,
      minimumRamBytes: 1,
      minimumVramBytes: 0,
      sha256: createHash("sha256").update(pack).digest("hex"),
      downloadUrl: modelUrl,
      license: "MIT",
      descriptionSource: modelUrl,
    };
    writeFileSync(join(root, "catalog.json"), JSON.stringify([entry]));
    const site = cli(
      "site-create",
      "-name",
      "speech",
      "-operations",
      "media.transcode,media.transcribe,media.subtitles",
    );
    const siteToken = cli(
      "token-issue",
      "-purpose",
      "SITE",
      "-id",
      site.id,
    ).token;
    const device = cli("device-create", "-name", "speech-device");
    const deviceToken = cli(
      "token-issue",
      "-purpose",
      "DEVICE",
      "-id",
      device.id,
    ).token;
    cli("catalog-import", "-catalog", join(root, "catalog.json"));
    const installId = randomUUID();
    const activateId = randomUUID();
    writeFileSync(
      join(root, "install.json"),
      JSON.stringify({
        requestId: installId,
        type: "MODEL_INSTALL",
        modelId: entry.id,
        modelRevision: entry.revision,
      }),
    );
    writeFileSync(
      join(root, "activate.json"),
      JSON.stringify({
        requestId: activateId,
        type: "MODEL_ACTIVATE",
        modelId: entry.id,
        modelRevision: entry.revision,
      }),
    );
    cli(
      "command-enqueue",
      "-id",
      device.id,
      "-command",
      join(root, "install.json"),
    );
    cli(
      "command-enqueue",
      "-id",
      device.id,
      "-command",
      join(root, "activate.json"),
    );
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let agent: Agent | undefined;
    const server = spawn(
      executable!,
      [
        "serve",
        "-db",
        db,
        "-listen",
        `127.0.0.1:${port}`,
        "-lease",
        "60s",
        "-heartbeat",
        "1s",
        "-stop-safety",
        "1s",
        "-admission-stable",
        "0s",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(async () => {
      await agent?.close();
      server.kill();
      storage.close();
      await delay(300);
      rmSync(root, { recursive: true, force: true });
    });
    await until(async () => {
      try {
        return (await fetch(base + "/healthz")).ok;
      } catch {
        return false;
      }
    });
    const work = join(root, "work");
    mkdirSync(work);
    const config: Config = {
      url: base.replace("http:", "ws:") + "/api/v2/device/connect",
      deviceId: device.id,
      stateDir: join(root, "state"),
      workDir: work,
      maxParallel: 1,
      reserveMemoryBytes: 0,
      taskMemoryBytes: 1,
      reserveDiskBytes: 0,
      threshold: 80,
      paused: false,
      testExecutor: false,
      testDurationMs: 3000,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      catalogExtra: join(root, "catalog.json"),
      allowTestModels: true,
    };
    agent = new Agent(
      config,
      deviceToken,
      new Journal(config.stateDir),
      () => {},
    );
    agent.resources.sample = () => ({
      cpuPercent: 10,
      memoryUsedPercent: 20,
      memoryPressure: "NORMAL",
      diskUsedPercent: 10,
      freeMemoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3,
      freeVramBytes: null,
      encoderBusyPercent: null,
      availableSlots: 1,
      paused: false,
      workDiskAvailable: true,
    });
    agent.start();
    await until(() => !!agent?.session);
    await until(
      () =>
        !!agent?.journal.state.models.some(
          (m) => m.state === "ACTIVE" && m.id === entry.id,
        ),
      20000,
    );
    await delay(1500);
    const headers = {
      Authorization: `Bearer ${siteToken}`,
      "Content-Type": "application/json",
    };
    const unsupported = {
      protocolVersion: "2.0",
      id: randomUUID(),
      type: "media.subtitles",
      source: {
        objectName: "uploads/audio.json",
        revision: randomUUID(),
        bytes: source.length,
        sha256: createHash("sha256").update(source).digest("hex"),
        contentType: "application/json",
        role: "PUBLISHED_MEDIA",
        kind: "FILE",
      },
      params: {
        speech: { sourceLanguage: "en", mode: "FAST" },
        includeOriginal: true,
        targetLanguages: ["zh"],
        formats: ["vtt"],
      },
      maxOutputBytes: 1073741824,
      maxDurationSeconds: 7200,
    };
    const rejected = await fetch(base + "/api/v2/site/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify(unsupported),
    });
    const rejectedView = await rejected.json();
    assert.equal(rejectedView.status, "REJECTED");
    assert.equal(rejectedView.manualEntryOffered, true);
    const job = {
      protocolVersion: "2.0",
      id: randomUUID(),
      type: "media.transcribe",
      source: unsupported.source,
      params: { sourceLanguage: "auto", mode: "FAST" },
      maxOutputBytes: 1073741824,
      maxDurationSeconds: 7200,
    };
    const submit = await fetch(base + "/api/v2/site/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify(job),
    });
    assert.equal(submit.status, 202);
    const objectUrl = (name: string) =>
      `http://127.0.0.1:${storagePort}/` + encodeURIComponent(name);
    await until(async () => {
      const view = await (
        await fetch(base + "/api/v2/site/jobs/" + job.id, { headers })
      ).json();
      const transfers = await (
        await fetch(base + "/api/v2/site/jobs/" + job.id + "/transfers", {
          headers,
        })
      ).json();
      for (const req of transfers.requests || []) {
        if (req.kind === "SOURCE") {
          await fetch(
            base + "/api/v2/site/jobs/" + job.id + "/transfer-grants",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                protocolVersion: "2.0",
                requestId: req.id,
                fence: req.fence,
                links: [
                  {
                    path: "source",
                    objectName: "uploads/audio.json",
                    url: objectUrl("uploads/audio.json"),
                    expiresAt: new Date(Date.now() + 3600000).toISOString(),
                    method: "GET",
                    headers: {},
                  },
                ],
                page: 0,
                lastPage: true,
              }),
            },
          );
        }
        if (req.kind === "UPLOAD") {
          const prefix =
            "jobs/" +
            site.id +
            "/" +
            job.id +
            "/" +
            req.fence.dispatcherEpoch +
            "/" +
            req.fence.generation +
            "/" +
            req.fence.assignmentId +
            "/";
          await fetch(
            base + "/api/v2/site/jobs/" + job.id + "/transfer-grants",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                protocolVersion: "2.0",
                requestId: req.id,
                fence: req.fence,
                links: req.artifact.manifest.files.map((file: any) => ({
                  path: file.path,
                  objectName: prefix + file.path,
                  url: objectUrl(prefix + file.path),
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                  method: "PUT",
                  headers: { "Content-Type": file.contentType },
                })),
                page: 0,
                lastPage: true,
              }),
            },
          );
        }
      }
      if (view.status === "AWAITING_PUBLICATION") {
        const claimId = randomUUID();
        await fetch(
          base + "/api/v2/site/jobs/" + job.id + "/publication-claim",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              protocolVersion: "2.0",
              claimId,
              artifactId: view.artifact.id,
              manifestSha256: view.artifact.manifestSha256,
              fence: view.artifact.fence,
            }),
          },
        );
        await fetch(
          base + "/api/v2/site/jobs/" + job.id + "/publication-decision",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              protocolVersion: "2.0",
              artifactId: view.artifact.id,
              fence: view.artifact.fence,
              manifestSha256: view.artifact.manifestSha256,
              decision: "PUBLISHED",
              publicationId: randomUUID(),
              claimId,
            }),
          },
        );
        return true;
      }
      return ["FAILED", "REJECTED"].includes(view.status);
    }, 30000);
    const done = await (
      await fetch(base + "/api/v2/site/jobs/" + job.id, { headers })
    ).json();
    assert.equal(done.status, "SUCCEEDED");
    assert.equal(done.artifact.manifest.detectedLanguage, "en");
    const transcript = [...objects.entries()].find(([k]) =>
      k.endsWith("transcript.txt"),
    );
    assert.ok(transcript);
    assert.equal(transcript![1].toString("utf8"), "Hello from catalog test.");
  },
);
test(
  "video remains when a subtitle language fails",
  { skip: !executable || !hasFfmpeg(), timeout: 90000 },
  async (t) => {
    const { createHash } = await import("node:crypto");
    const { createServer } = await import("node:http");
    const { writeFileSync, readFileSync: read } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "processor-partial-"));
    const db = join(root, "dispatcher.db");
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(executable!, [...args, "-db", db], {
          encoding: "utf8",
          windowsHide: true,
        }),
      );
    const source = join(root, "source.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1280x720:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-c:a",
        "aac",
        "-ac",
        "1",
        "-b:a",
        "96k",
        "-b:v",
        "1000k",
        source,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const bytes = read(source);
    const speechPack = Buffer.from(
      JSON.stringify({
        language: "en",
        text: "Hello from catalog test.",
        cues: [{ start: 0, end: 1, text: "Hello from catalog test." }],
      }),
      "utf8",
    );
    const translatePack = Buffer.from(
      JSON.stringify({
        failTargets: ["uk"],
        map: {
          ru: { "Hello from catalog test.": "Привет из проверки каталога." },
        },
      }),
      "utf8",
    );
    const objects = new Map<string, Buffer>();
    objects.set("uploads/video.mp4", bytes);
    objects.set("models/speech.json", speechPack);
    objects.set("models/translate.json", translatePack);
    const storage = createServer((req, res) => {
      const key = decodeURIComponent((req.url || "/").slice(1));
      if (req.method === "GET") {
        const body = objects.get(key);
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(body);
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200);
          res.end();
        });
        return;
      }
      res.writeHead(405);
      res.end();
    });
    await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
    const storagePort = (storage.address() as net.AddressInfo).port;
    const speechUrl = `http://127.0.0.1:${storagePort}/models/speech.json`;
    const translateUrl = `http://127.0.0.1:${storagePort}/models/translate.json`;
    const catalog = [
      {
        id: "catalog-test-speech",
        revision: "test-1",
        executor: "catalog-test",
        purpose: "RECOGNITION",
        os: ["windows", "darwin", "linux"],
        architectures: ["amd64", "arm64"],
        accelerators: ["cpu"],
        recognitionLanguages: ["en", "uk", "yue"],
        translationDirections: [],
        downloadBytes: speechPack.length,
        minimumRamBytes: 1,
        minimumVramBytes: 0,
        sha256: createHash("sha256").update(speechPack).digest("hex"),
        downloadUrl: speechUrl,
        license: "MIT",
        descriptionSource: speechUrl,
      },
      {
        id: "catalog-test-translate",
        revision: "test-1",
        executor: "catalog-test",
        purpose: "TRANSLATION",
        os: ["windows", "darwin", "linux"],
        architectures: ["amd64", "arm64"],
        accelerators: ["cpu"],
        recognitionLanguages: [],
        translationDirections: [
          { source: "en", target: "ru" },
          { source: "en", target: "uk" },
        ],
        downloadBytes: translatePack.length,
        minimumRamBytes: 1,
        minimumVramBytes: 0,
        sha256: createHash("sha256").update(translatePack).digest("hex"),
        downloadUrl: translateUrl,
        license: "MIT",
        descriptionSource: translateUrl,
      },
    ];
    writeFileSync(join(root, "catalog.json"), JSON.stringify(catalog));
    const site = cli(
      "site-create",
      "-name",
      "partial",
      "-operations",
      "media.transcode,media.transcribe,media.subtitles",
    );
    const siteToken = cli(
      "token-issue",
      "-purpose",
      "SITE",
      "-id",
      site.id,
    ).token;
    const device = cli("device-create", "-name", "partial-device");
    const deviceToken = cli(
      "token-issue",
      "-purpose",
      "DEVICE",
      "-id",
      device.id,
    ).token;
    cli("catalog-import", "-catalog", join(root, "catalog.json"));
    for (const item of catalog) {
      const install = randomUUID();
      const activate = randomUUID();
      writeFileSync(
        join(root, item.id + "-install.json"),
        JSON.stringify({
          requestId: install,
          type: "MODEL_INSTALL",
          modelId: item.id,
          modelRevision: item.revision,
        }),
      );
      writeFileSync(
        join(root, item.id + "-activate.json"),
        JSON.stringify({
          requestId: activate,
          type: "MODEL_ACTIVATE",
          modelId: item.id,
          modelRevision: item.revision,
        }),
      );
      cli(
        "command-enqueue",
        "-id",
        device.id,
        "-command",
        join(root, item.id + "-install.json"),
      );
      cli(
        "command-enqueue",
        "-id",
        device.id,
        "-command",
        join(root, item.id + "-activate.json"),
      );
    }
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let agent: Agent | undefined;
    const server = spawn(
      executable!,
      [
        "serve",
        "-db",
        db,
        "-listen",
        `127.0.0.1:${port}`,
        "-lease",
        "60s",
        "-heartbeat",
        "1s",
        "-stop-safety",
        "1s",
        "-admission-stable",
        "0s",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    t.after(async () => {
      await agent?.close();
      server.kill();
      storage.close();
      await delay(300);
      rmSync(root, { recursive: true, force: true });
    });
    await until(async () => {
      try {
        return (await fetch(base + "/healthz")).ok;
      } catch {
        return false;
      }
    });
    const work = join(root, "work");
    mkdirSync(work);
    const config: Config = {
      url: base.replace("http:", "ws:") + "/api/v2/device/connect",
      deviceId: device.id,
      stateDir: join(root, "state"),
      workDir: work,
      maxParallel: 1,
      reserveMemoryBytes: 0,
      taskMemoryBytes: 1,
      reserveDiskBytes: 0,
      threshold: 80,
      paused: false,
      testExecutor: false,
      testDurationMs: 3000,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      catalogExtra: join(root, "catalog.json"),
      allowTestModels: true,
    };
    agent = new Agent(
      config,
      deviceToken,
      new Journal(config.stateDir),
      () => {},
    );
    agent.resources.sample = () => ({
      cpuPercent: 10,
      memoryUsedPercent: 20,
      memoryPressure: "NORMAL",
      diskUsedPercent: 10,
      freeMemoryBytes: 8 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3,
      freeVramBytes: null,
      encoderBusyPercent: null,
      availableSlots: 1,
      paused: false,
      workDiskAvailable: true,
    });
    agent.start();
    await until(() => !!agent?.session);
    await until(
      () =>
        agent!.journal.state.models.filter((m) => m.state === "ACTIVE")
          .length === 2,
      20000,
    );
    await delay(1500);
    const headers = {
      Authorization: `Bearer ${siteToken}`,
      "Content-Type": "application/json",
    };
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../contracts/fixtures/valid/job-video.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ).value;
    fixture.id = randomUUID();
    fixture.source.bytes = bytes.length;
    fixture.source.sha256 = createHash("sha256").update(bytes).digest("hex");
    fixture.params.subtitles = {
      speech: { sourceLanguage: "auto", mode: "AUTO" },
      includeOriginal: true,
      targetLanguages: ["ru", "uk"],
      formats: ["vtt"],
    };
    const submit = await fetch(base + "/api/v2/site/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify(fixture),
    });
    assert.equal(submit.status, 202);
    const objectUrl = (name: string) =>
      `http://127.0.0.1:${storagePort}/` + encodeURIComponent(name);
    await until(async () => {
      const view = await (
        await fetch(base + "/api/v2/site/jobs/" + fixture.id, { headers })
      ).json();
      const transfers = await (
        await fetch(base + "/api/v2/site/jobs/" + fixture.id + "/transfers", {
          headers,
        })
      ).json();
      for (const req of transfers.requests || []) {
        if (req.kind === "SOURCE") {
          await fetch(
            base + "/api/v2/site/jobs/" + fixture.id + "/transfer-grants",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                protocolVersion: "2.0",
                requestId: req.id,
                fence: req.fence,
                links: [
                  {
                    path: "source",
                    objectName: "uploads/video.mp4",
                    url: objectUrl("uploads/video.mp4"),
                    expiresAt: new Date(Date.now() + 3600000).toISOString(),
                    method: "GET",
                    headers: {},
                  },
                ],
                page: 0,
                lastPage: true,
              }),
            },
          );
        }
        if (req.kind === "UPLOAD") {
          const prefix =
            "jobs/" +
            site.id +
            "/" +
            fixture.id +
            "/" +
            req.fence.dispatcherEpoch +
            "/" +
            req.fence.generation +
            "/" +
            req.fence.assignmentId +
            "/";
          await fetch(
            base + "/api/v2/site/jobs/" + fixture.id + "/transfer-grants",
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                protocolVersion: "2.0",
                requestId: req.id,
                fence: req.fence,
                links: req.artifact.manifest.files.map((file: any) => ({
                  path: file.path,
                  objectName: prefix + file.path,
                  url: objectUrl(prefix + file.path),
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                  method: "PUT",
                  headers: { "Content-Type": file.contentType },
                })),
                page: 0,
                lastPage: true,
              }),
            },
          );
        }
      }
      if (view.status === "AWAITING_PUBLICATION") {
        const claimId = randomUUID();
        await fetch(
          base + "/api/v2/site/jobs/" + fixture.id + "/publication-claim",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              protocolVersion: "2.0",
              claimId,
              artifactId: view.artifact.id,
              manifestSha256: view.artifact.manifestSha256,
              fence: view.artifact.fence,
            }),
          },
        );
        await fetch(
          base + "/api/v2/site/jobs/" + fixture.id + "/publication-decision",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              protocolVersion: "2.0",
              artifactId: view.artifact.id,
              fence: view.artifact.fence,
              manifestSha256: view.artifact.manifestSha256,
              decision: "PUBLISHED",
              publicationId: randomUUID(),
              claimId,
            }),
          },
        );
        return true;
      }
      return ["FAILED", "REJECTED"].includes(view.status);
    }, 60000);
    const done = await (
      await fetch(base + "/api/v2/site/jobs/" + fixture.id, { headers })
    ).json();
    assert.equal(done.status, "PARTIAL");
    assert.equal(done.manualEntryOffered, true);
    assert.ok(
      done.artifact.manifest.steps.some(
        (s: any) => s.name === "video" && s.status === "SUCCEEDED",
      ),
    );
    assert.ok(
      done.artifact.manifest.steps.some(
        (s: any) =>
          s.name === "subtitles" &&
          s.language === "ru" &&
          s.status === "SUCCEEDED",
      ),
    );
    assert.ok(
      done.artifact.manifest.steps.some(
        (s: any) =>
          s.name === "subtitles" &&
          s.language === "uk" &&
          s.status === "FAILED",
      ),
    );
    assert.ok([...objects.keys()].some((k) => k.endsWith("index.m3u8")));
    assert.ok([...objects.keys()].some((k) => k.endsWith("subtitles/ru.vtt")));
    assert.ok(
      [...objects.keys()].every((k) => !k.endsWith("subtitles/uk.vtt")),
    );
  },
);
