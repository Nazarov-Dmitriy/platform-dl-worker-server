import os from "node:os";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { Journal, type Attempt } from "./journal.js";
import { frame, parseFrame, sameFence, type Frame } from "./protocol.js";
import { LeaseClock } from "./lease.js";
import { Resources, testCapabilities } from "./resources.js";
import { Executor } from "./executor.js";
import { cleanupWork, createAttemptDir, utcDate } from "./files.js";
import { downloadLink, sha256File, TransferError, uploadLink, type Link } from "./transfer.js";
import { sha256Canonical } from "./jcs.js";
type Running = {
  attempt: Attempt;
  job?: any;
  lease: LeaseClock;
  executor?: Executor;
  progress: number | null;
  activity: number;
  ending: boolean;
  lastRenewal: Frame;
  nextRenew: number;
  lastProgress: number;
  acceptedAt: number;
  diskBytes: number;
  grants: Link[];
  acks: Set<string>;
};
export class Agent {
  socket?: WebSocket;
  session = false;
  closing = false;
  heartbeat = 15;
  safety = 5;
  backoff = 1000;
  nextHeartbeat = 0;
  running = new Map<string, Running>();
  timer?: NodeJS.Timeout;
  reconnect?: NodeJS.Timeout;
  readonly resources: Resources;
  readonly ffmpeg: boolean;
  chain: Promise<void> = Promise.resolve();
  closePromise?: Promise<void>;
  constructor(
    readonly config: Config,
    readonly token: string,
    readonly journal: Journal,
    readonly log: (event: string) => void = console.log,
  ) {
    this.resources = new Resources(config, journal);
    this.ffmpeg =
      hasBin(config.ffmpeg) && hasBin(config.ffprobe);
    this.sweep();
  }
  caps() {
    return this.config.testExecutor || this.ffmpeg ? testCapabilities : [];
  }
  usage() {
    const usage = this.resources.sample();
    const held = [...this.running.values()].reduce(
      (total, r) => total + r.diskBytes,
      0,
    );
    const pending = this.journal.state.attempts
      .filter((a) => a.awaitingPublication)
      .reduce((total, a) => total + (a.diskBytes || 0), 0);
    usage.freeDiskBytes = Math.max(0, usage.freeDiskBytes - held - pending);
    return usage;
  }
  start() {
    for (const a of [...this.journal.state.attempts]) {
      if (a.awaitingPublication) continue;
      this.enqueueFailure(
        a,
        "PROCESSOR_RESTARTED",
        "Processor restarted; prior executor was stopped",
      );
    }
    this.connect();
    this.timer = setInterval(() => this.tick(), 100);
  }
  send(f: Frame) {
    if (this.session && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(f));
  }
  connect() {
    if (this.closing) return;
    this.session = false;
    const ws = new WebSocket(this.config.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeout: 10000,
      maxPayload: 8 * 1024 ** 2,
      rejectUnauthorized: true,
    });
    this.socket = ws;
    ws.on("open", () => {
      const usage = this.usage();
      const active = [...this.running.values()].map((r) => ({
        jobId: r.attempt.jobId,
        fence: r.attempt.fence,
      }));
      for (const a of this.journal.state.attempts) {
        if (
          a.awaitingPublication &&
          !active.some((x) => sameFence(x.fence, a.fence)) &&
          active.length < 64
        )
          active.push({ jobId: a.jobId, fence: a.fence });
      }
      for (const out of this.journal.state.outbox) {
        if (
          out.body.fence &&
          !active.some((a) => sameFence(a.fence, out.body.fence)) &&
          active.length < 64
        )
          active.push({ jobId: out.body.jobId, fence: out.body.fence });
      }
      ws.send(
        JSON.stringify(
          frame("device.hello", {
            deviceId: this.config.deviceId,
            agentVersion: "0.4.0",
            os: process.platform === "win32" ? "windows" : process.platform,
            architecture: process.arch === "x64" ? "amd64" : process.arch,
            memoryBytes: os.totalmem(),
            cpuCores: os.cpus().length,
            accelerators: [],
            capabilities: this.caps(),
            usage,
            active,
          }),
        ),
      );
    });
    ws.on("message", (raw) => {
      this.chain = this.chain
        .then(async () => {
          if (this.socket !== ws || this.closing) return;
          const f = parseFrame(raw.toString(), "DOWN");
          await this.receive(f);
        })
        .catch(() => {
          this.log("PROTOCOL_OR_STATE_ERROR");
          ws.terminate();
        });
    });
    ws.on("error", () => this.log("CONNECTION_ERROR"));
    ws.on("close", () => {
      if (this.socket !== ws) return;
      this.session = false;
      if (!this.closing) {
        this.log("RECONNECT_WAIT");
        this.reconnect = setTimeout(
          () => this.connect(),
          this.backoff + Math.random() * 250,
        );
        this.backoff = Math.min(30000, this.backoff * 2);
      }
    });
  }
  async receive(f: Frame) {
    const b = f.body;
    if (f.type === "session.welcome") {
      if (b.leaseSeconds <= b.heartbeatSeconds + b.stopSafetySeconds)
        throw new Error("UNSAFE_LEASE");
      this.heartbeat = b.heartbeatSeconds;
      this.safety = b.stopSafetySeconds;
      this.session = true;
      this.backoff = 1000;
      this.nextHeartbeat = 0;
      this.log("CONNECTED");
      for (const r of this.running.values()) {
        if (!r.ending) this.renew(r, true);
      }
      for (const out of this.journal.state.outbox) this.send(out);
      return;
    }
    if (!this.session) throw new Error("WELCOME_REQUIRED");
    if (f.type === "job.offer") {
      const id = b.fence.assignmentId;
      if (this.running.has(id)) return;
      if (b.jobId !== b.job.id) throw new Error("OFFER_JOB_MISMATCH");
      const usage = this.usage();
      const transcode = b.job.type === "media.transcode";
      const ready =
        (this.config.testExecutor || (this.ffmpeg && transcode)) &&
        this.running.size < usage.availableSlots &&
        usage.freeDiskBytes >= b.job.source.bytes + b.job.maxOutputBytes &&
        usage.workDiskAvailable;
      if (!ready) {
        this.queue(
          frame("job.decline", {
            jobId: b.jobId,
            fence: b.fence,
            error: {
              code: this.config.testExecutor || this.ffmpeg
                ? "RESOURCES_UNAVAILABLE"
                : "FFMPEG_UNAVAILABLE",
              message: "Local admission is unavailable",
              permanent: !this.config.testExecutor && !this.ffmpeg,
            },
          }),
        );
        return;
      }
      const accept = frame("job.accept", { jobId: b.jobId, fence: b.fence });
      const attempt: Attempt = {
        jobId: b.jobId,
        fence: b.fence,
        accept,
        started: false,
        job: b.job,
        diskBytes: b.job.source.bytes + b.job.maxOutputBytes,
      };
      this.journal.state.attempts.push(attempt);
      this.journal.save();
      const r: Running = {
        attempt,
        job: b.job,
        lease: new LeaseClock(),
        progress: null,
        activity: 0,
        ending: false,
        lastRenewal: accept,
        nextRenew: Date.now() + 1000,
        lastProgress: Date.now(),
        acceptedAt: Date.now(),
        diskBytes: attempt.diskBytes!,
        grants: [],
        acks: new Set(),
      };
      this.running.set(id, r);
      r.lease.sent(accept.messageId);
      this.send(accept);
      return;
    }
    if (f.type === "protocol.ack") {
      this.journal.state.outbox = this.journal.state.outbox.filter(
        (out) => out.messageId !== b.replyTo,
      );
      this.journal.save();
      const r = [...this.running.values()].find((x) =>
        x.acks.has(b.replyTo),
      );
      r?.acks.delete(b.replyTo);
      return;
    }
    if (f.type === "protocol.error") {
      const out = this.journal.state.outbox.find(
        (out) => out.messageId === b.replyTo,
      );
      if (out && ["STALE_ASSIGNMENT", "LEASE_EXPIRED"].includes(b.error.code)) {
        this.journal.state.outbox = this.journal.state.outbox.filter(
          (item) => item !== out,
        );
        this.journal.save();
      }
      for (const r of this.running.values()) {
        if (r.lastRenewal.messageId === b.replyTo) {
          if (
            [
              "STOP_REQUIRED",
              "STALE_ASSIGNMENT",
              "LEASE_EXPIRED",
              "INVALID_TRANSITION",
              "DEVICE_SESSION_INVALID",
            ].includes(b.error.code)
          )
            await this.finish(
              r,
              b.error.code,
              b.error.code === "STOP_REQUIRED",
            );
        }
      }
      this.log("DISPATCHER_" + b.error.code);
      return;
    }
    if (f.type === "job.publication.done") {
      const held = this.journal.state.attempts.find(
        (a) =>
          a.jobId === b.jobId &&
          sameFence(a.fence, b.fence) &&
          a.awaitingPublication,
      );
      if (held) {
        this.releaseHeld(held);
        this.log("PUBLICATION_" + b.outcome);
      }
      return;
    }
    const r = this.running.get(b.fence?.assignmentId);
    if (f.type === "job.stop" && !r) {
      const failed = this.journal.state.outbox.find(
        (out) =>
          out.type === "job.failed" &&
          out.body.jobId === b.jobId &&
          sameFence(out.body.fence, b.fence),
      );
      if (failed) {
        this.journal.state.outbox = this.journal.state.outbox.filter(
          (out) => out !== failed,
        );
        this.queue(frame("job.stopped", { jobId: b.jobId, fence: b.fence }));
      }
      const held = this.journal.state.attempts.find(
        (a) =>
          a.jobId === b.jobId &&
          sameFence(a.fence, b.fence) &&
          a.awaitingPublication,
      );
      if (held) this.releaseHeld(held);
      return;
    }
    if (
      !r ||
      !sameFence(r.attempt.fence, b.fence) ||
      r.attempt.jobId !== b.jobId
    )
      return;
    if (f.type === "job.stop") {
      await this.finish(r, "STOP_REQUESTED", true);
      return;
    }
    if (f.type === "job.source.granted" || f.type === "job.upload.granted") {
      for (const link of b.grant.links as Link[]) {
        r.grants = r.grants.filter((g) => g.path !== link.path).concat(link);
      }
      return;
    }
    if (f.type === "lease.granted") {
      if (r.ending || !r.lease.grant(b.renewalId, b.leaseSeconds, this.safety))
        return;
      if (!r.executor) {
        r.attempt.started = true;
        this.journal.save();
        if (this.config.testExecutor) this.startTest(r);
        else this.startVideo(r);
      } else r.executor.renew(this.config.testDurationMs, r.lease);
      return;
    }
  }
  startTest(r: Running) {
    r.executor = new Executor(this.config.testDurationMs, r.lease, (m) => {
      if (r.ending) return;
      if (m.type === "progress") {
        r.progress = m.progress;
        r.activity = m.sequence;
        r.lastProgress = Date.now();
      }
      if (m.type === "finished" || m.type === "executor-error")
        this.chain = this.chain
          .then(() =>
            this.finish(
              r,
              m.type === "finished" ? "TEST_EXECUTOR_ONLY" : "EXECUTOR_FAILED",
            ),
          )
          .catch(() => this.close());
    });
    r.executor.child.once("exit", () => {
      if (!r.ending)
        this.chain = this.chain
          .then(() => this.finish(r, "EXECUTOR_EXITED"))
          .catch(() => this.close());
    });
    this.log("TEST_EXECUTOR_STARTED");
  }
  startVideo(r: Running) {
    void this.runVideo(r).catch((e) => {
      if (r.ending) return;
      const err = e instanceof TransferError ? e : null;
      return this.finish(
        r,
        err?.code || (e instanceof Error ? e.message : "VIDEO_FAILED"),
        false,
        err?.permanent ?? true,
      );
    });
  }
  async runVideo(r: Running) {
    const job = r.job || r.attempt.job;
    if (!job || job.type !== "media.transcode" || job.source.kind !== "FILE")
      throw new TransferError("UNSUPPORTED_SOURCE", "Only FILE transcode is implemented", false, true);
    if (!r.lease.valid()) throw new TransferError("LEASE_EXPIRED", "Lease expired", false, true);
    const dir = createAttemptDir(
      this.config.workDir,
      r.attempt.fence.assignmentId,
      this.journal,
    );
    r.attempt.dir = dir;
    this.journal.save();
    await this.durable(
      r,
      frame("job.source.request", {
        jobId: r.attempt.jobId,
        fence: r.attempt.fence,
      }),
    );
    const dest = join(dir, "source.mp4");
    r.progress = 0.05;
    await this.transfer("source", "GET", r, (link) =>
      downloadLink(link, dest, job.source.bytes, job.source.sha256),
    );
    if (!r.lease.valid()) throw new TransferError("LEASE_EXPIRED", "Lease expired", false, true);
    const outDir = join(dir, "hls");
    let packaged: any;
    await new Promise<void>((resolve, reject) => {
      r.executor = new Executor(
        3600000,
        r.lease,
        (m) => {
          if (r.ending) return;
          if (m.type === "progress") {
            r.progress = 0.1 + Math.min(0.7, (m.progress || 0) * 0.7);
            r.activity = m.sequence;
            r.lastProgress = Date.now();
          }
          if (m.type === "packaged") {
            packaged = m;
            resolve();
          }
          if (m.type === "failed" || m.type === "executor-error")
            reject(new Error(m.code || "EXECUTOR_FAILED"));
        },
        new URL("./video-child.js", import.meta.url),
        {
          source: dest,
          outDir,
          profile: job.params.profile,
          maxDurationSeconds: job.maxDurationSeconds,
          ffmpeg: this.config.ffmpeg,
          ffprobe: this.config.ffprobe,
        },
      );
      r.executor.child.once("exit", (code) => {
        if (!packaged && !r.ending)
          reject(new Error(code ? "EXECUTOR_EXITED" : "EXECUTOR_EXITED"));
      });
    });
    const manifestFiles = await listPackage(outDir);
    let total = 0;
    for (const file of manifestFiles) total += file.bytes;
    if (total > job.maxOutputBytes)
      throw new TransferError("OUTPUT_LIMIT", "Package exceeds maxOutputBytes", false, true);
    const steps: any[] = [{ name: "video", status: "SUCCEEDED" }];
    for (const lang of job.params?.subtitles?.targetLanguages || []) {
      steps.push({
        name: "subtitles",
        language: lang,
        status: "SKIPPED",
        error: {
          code: "MODEL_NOT_INSTALLED",
          message: "Subtitle models are installed at stage 5",
          permanent: true,
        },
      });
    }
    const manifest = {
      files: manifestFiles,
      steps,
      masterPath: "index.m3u8",
      renditions: packaged.renditions,
    };
    const artifact = {
      id: randomUUID(),
      manifestSha256: sha256Canonical(manifest),
      fence: r.attempt.fence,
      manifest,
    };
    await this.durable(
      r,
      frame("job.artifact.propose", {
        jobId: r.attempt.jobId,
        fence: r.attempt.fence,
        artifact,
      }),
    );
    r.progress = 0.85;
    for (const file of manifestFiles) {
      await this.transfer(file.path, "PUT", r, (link) =>
        uploadLink(link, join(outDir, file.path)),
      );
    }
    r.attempt.awaitingPublication = true;
    r.attempt.started = true;
    this.journal.save();
    await this.durable(
      r,
      frame("job.upload.complete", {
        jobId: r.attempt.jobId,
        fence: r.attempt.fence,
        artifactId: artifact.id,
        manifestSha256: artifact.manifestSha256,
      }),
    );
    if (r.executor) await r.executor.stop();
    r.ending = true;
    this.running.delete(r.attempt.fence.assignmentId);
    this.journal.save();
    this.log("AWAITING_PUBLICATION");
  }
  durable(r: Running, f: Frame) {
    r.acks.add(f.messageId);
    this.queue(f);
    return until(
      () => !r.acks.has(f.messageId) || r.ending,
      120000,
    ).then(() => {
      if (r.ending || r.acks.has(f.messageId)) throw new Error("ACK_TIMEOUT");
    });
  }
  async transfer(
    path: string,
    method: "GET" | "PUT",
    r: Running,
    run: (link: Link) => Promise<void>,
  ) {
    for (;;) {
      const link = await this.waitLink(r, path, method);
      try {
        await run(link);
        return;
      } catch (e) {
        if (e instanceof TransferError && e.refresh) {
          r.grants = r.grants.filter((g) => g.path !== path);
          continue;
        }
        throw e;
      }
    }
  }
  async waitLink(r: Running, path: string, method: "GET" | "PUT"): Promise<Link> {
    await until(
      () =>
        r.ending ||
        r.grants.some((g) => g.path === path && g.method === method),
      120000,
    );
    if (r.ending) throw new Error("STOPPED");
    return r.grants.find((g) => g.path === path && g.method === method)!;
  }
  queue(f: Frame) {
    this.journal.state.outbox.push(f);
    this.journal.save();
    this.send(f);
    return f;
  }
  enqueueFailure(a: Attempt, code: string, message: string, permanent = false) {
    this.journal.state.attempts = this.journal.state.attempts.filter(
      (x) => x.fence.assignmentId !== a.fence.assignmentId,
    );
    if (a.dir) cleanupWork(this.config.workDir, this.keep());
    this.queue(
      frame("job.failed", {
        jobId: a.jobId,
        fence: a.fence,
        error: {
          code,
          message,
          permanent: permanent || code === "TEST_EXECUTOR_ONLY",
        },
      }),
    );
  }
  async finish(
    r: Running,
    code: string,
    stopped = false,
    permanent = false,
  ) {
    if (r.ending) return;
    r.ending = true;
    if (r.executor) await r.executor.stop();
    this.running.delete(r.attempt.fence.assignmentId);
    if (stopped)
      this.journal.state.attempts = this.journal.state.attempts.filter(
        (a) => a.fence.assignmentId !== r.attempt.fence.assignmentId,
      );
    this.sweep();
    if (stopped)
      this.queue(
        frame("job.stopped", {
          jobId: r.attempt.jobId,
          fence: r.attempt.fence,
        }),
      );
    else
      this.enqueueFailure(
        r.attempt,
        code,
        code === "TEST_EXECUTOR_ONLY"
          ? "Transport test completed; media executor is not installed"
          : "Executor stopped: " + code,
        permanent,
      );
    this.log(code);
  }
  releaseHeld(a: Attempt) {
    this.journal.state.attempts = this.journal.state.attempts.filter(
      (x) => x.fence.assignmentId !== a.fence.assignmentId,
    );
    this.journal.save();
    this.sweep();
  }
  keep() {
    const keep = new Set<string>();
    for (const r of this.running.values())
      if (r.attempt.dir) keep.add(r.attempt.dir);
    for (const a of this.journal.state.attempts)
      if (a.dir && a.awaitingPublication) keep.add(a.dir);
    return keep;
  }
  sweep() {
    try {
      cleanupWork(this.config.workDir, this.keep());
      this.journal.state.lastCleanupDate = utcDate();
      this.journal.save();
    } catch {
      this.log("WORK_CLEANUP_SKIPPED");
    }
  }
  renew(r: Running, reconnect = false) {
    if (r.ending) return;
    if (!r.lease.granted) {
      r.lease.sent(r.attempt.accept.messageId);
      this.send(r.attempt.accept);
      r.nextRenew = Date.now() + 1000;
      return;
    }
    if (!r.lease.valid()) {
      void this.finish(r, "LEASE_EXPIRED").catch(() => this.close());
      return;
    }
    const id = randomUUID();
    const f = frame("job.status", {
      jobId: r.attempt.jobId,
      fence: r.attempt.fence,
      renewalId: id,
      stage: r.attempt.awaitingPublication
        ? "WAITING_PUBLICATION"
        : r.executor
          ? "TRANSCODING"
          : "WAITING_SOURCE",
      progress: r.progress,
      activitySequence: r.activity,
      steps: [],
    });
    r.lastRenewal = f;
    r.lease.sent(id);
    this.send(f);
    r.nextRenew =
      Date.now() + Math.min(this.heartbeat * 1000, r.lease.remaining() / 3);
    if (reconnect) this.log("ATTEMPT_RECONCILED");
  }
  tick() {
    if (this.closing) return;
    try {
      if (this.journal.state.lastCleanupDate !== utcDate()) this.sweep();
      for (const r of this.running.values()) {
        if (r.ending) continue;
        if (r.lease.granted && !r.lease.valid()) {
          void this.finish(r, "LEASE_EXPIRED").catch(() => this.close());
          continue;
        }
        if (!r.lease.granted && Date.now() > r.acceptedAt + 15000) {
          void this.finish(r, "ACCEPT_TIMEOUT").catch(() => this.close());
          continue;
        }
        if (this.session && Date.now() >= r.nextRenew) this.renew(r);
        if (Date.now() - r.lastProgress >= 600000) {
          this.log("PROGRESS_DELAYED");
          r.lastProgress = Date.now();
        }
      }
      if (this.session && Date.now() >= this.nextHeartbeat) {
        this.send(
          frame("device.heartbeat", {
            capabilities: this.caps(),
            usage: this.usage(),
          }),
        );
        for (const out of this.journal.state.outbox) this.send(out);
        this.nextHeartbeat = Date.now() + this.heartbeat * 1000;
      }
    } catch {
      this.log("LOCAL_STATE_ERROR");
      void this.close();
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.closePromise = (async () => {
      await Promise.allSettled(
        [...this.running.values()].map((r) =>
          this.finish(r, "PROCESSOR_STOPPED"),
        ),
      );
      this.socket?.terminate();
      this.log("STOPPED");
    })();
    return this.closePromise;
  }
}
function hasBin(bin: string) {
  try {
    execFileSync(bin, ["-version"], {
      timeout: 4000,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
function until(check: () => boolean, timeout: number) {
  return new Promise<void>((resolve, reject) => {
    const end = Date.now() + timeout;
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > end) {
        clearInterval(timer);
        reject(new Error("WAIT_TIMEOUT"));
      }
    }, 50);
  });
}
function listPackage(root: string) {
  const out: {
    path: string;
    bytes: number;
    sha256: string;
    contentType: string;
    kind: string;
  }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? prefix + "/" + name : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else {
        const playlist = name.endsWith(".m3u8");
        out.push({
          path: rel.replace(/\\/g, "/"),
          bytes: statSync(full).size,
          sha256: "",
          contentType: playlist
            ? "application/vnd.apple.mpegurl"
            : "video/mp2t",
          kind:
            rel.replace(/\\/g, "/") === "index.m3u8"
              ? "MASTER"
              : playlist
                ? "PLAYLIST"
                : "SEGMENT",
        });
      }
    }
  };
  walk(root, "");
  return Promise.all(
    out.map(async (f) => ({
      ...f,
      sha256: await sha256File(join(root, f.path)),
    })),
  );
}
