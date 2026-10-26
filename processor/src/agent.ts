import { errorCode } from "./errors.js";
import { setAutostart } from "./autostart.js";
import { validateHlsInput } from "./hls-input.js";
import os from "node:os";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { Journal, type Attempt } from "./journal.js";
import { frame, parseFrame, sameFence, type Frame } from "./protocol.js";
import { LeaseClock } from "./lease.js";
import { Resources, transcodeCapability } from "./resources.js";
import { Executor } from "./executor.js";
import {
  assertWorkVolume,
  cleanupWork,
  createAttemptDir,
  utcDate,
} from "./files.js";
import {
  downloadLink,
  sha256File,
  TransferError,
  uploadLink,
  type Link,
} from "./transfer.js";
import { sha256Canonical } from "./jcs.js";
import { lookupCatalog, type ModelEntry } from "./catalog.js";
import {
  activateModel,
  deleteModel,
  installModel,
  modelReady,
  cleanupModelArtifacts,
} from "./models.js";
import {
  cuesToVtt,
  selectRecognition,
  selectTranslation,
  writeUtf8,
  type Cue,
  type Transcript,
} from "./speech.js";
type Running = {
  attempt: Attempt;
  job?: any;
  lease: LeaseClock;
  executor?: Executor;
  transferAbort?: AbortController;
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
  stage: string;
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
  commandChain: Promise<void> = Promise.resolve();
  closePromise?: Promise<void>;
  constructor(
    readonly config: Config,
    readonly token: string,
    readonly journal: Journal,
    readonly log: (event: string) => void = console.log,
  ) {
    const applied = journal.state.appliedSettings as any;
    if (applied) {
      config.workDir = resolve(applied.workDirectory);
      config.paused = Boolean(applied.paused);
      config.maxParallel = applied.maxParallel;
      config.cpuThresholdPercent = applied.cpuThresholdPercent;
      config.memoryThresholdPercent = applied.memoryThresholdPercent;
      config.diskThresholdPercent = applied.diskThresholdPercent;
      config.threshold = Math.min(
        applied.cpuThresholdPercent,
        applied.memoryThresholdPercent,
        applied.diskThresholdPercent,
      );
    }
    this.resources = new Resources(config, journal);
    this.ffmpeg = hasBin(config.ffmpeg) && hasBin(config.ffprobe);
    if (config.catalogExtra) {
      journal.state.catalog = JSON.parse(
        readFileSync(config.catalogExtra, "utf8"),
      ) as ModelEntry[];
      journal.save();
    }
    if (this.resources.sample().workDiskAvailable)
      cleanupModelArtifacts(config.workDir, journal);
    this.sweep();
  }
  readiness = new Map<string, { at: number; ready: boolean }>();
  readyModel(model: import("./journal.js").InstalledModel) {
    if (model.executor === "catalog-test" && !this.config.allowTestModels)
      return false;
    const key = model.path + ":" + model.executor;
    const cached = this.readiness.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.ready;
    const ready = modelReady(model, this.config.whisperCpp, this.config.ffmpeg);
    this.readiness.set(key, { at: Date.now(), ready });
    return ready;
  }
  caps() {
    const out: any[] = [];
    if (this.config.testExecutor || this.ffmpeg)
      out.push({ ...transcodeCapability });
    const rec = this.journal.state.models.filter(
      (m) =>
        m.state === "ACTIVE" &&
        m.purpose === "RECOGNITION" &&
        this.readyModel(m),
    );
    const tr = this.journal.state.models.filter(
      (m) =>
        m.state === "ACTIVE" &&
        m.purpose === "TRANSLATION" &&
        this.readyModel(m),
    );
    if (rec.length) {
      const langs = [...new Set(rec.flatMap((m) => m.recognitionLanguages))];
      langs.sort();
      const pairs = [
        ...new Map(
          tr
            .flatMap((m) => m.translationDirections)
            .map((p) => [p.source + ":" + p.target, p]),
        ).values(),
      ];
      out.push({
        code: "media.transcribe",
        recognitionLanguages: langs,
        translationDirections: [],
        autoDetect: true,
        formats: ["text"],
        availability: "ONLINE",
        profilePolicies: [],
      });
      out.push({
        code: "media.subtitles",
        recognitionLanguages: langs,
        translationDirections: pairs,
        autoDetect: true,
        formats: ["vtt"],
        availability: "ONLINE",
        profilePolicies: [],
      });
    }
    return out;
  }
  hasRecognition() {
    return this.journal.state.models.some(
      (m) =>
        m.state === "ACTIVE" &&
        m.purpose === "RECOGNITION" &&
        this.readyModel(m),
    );
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
      ...(this.config.tlsCaFile ? { ca: readFileSync(this.config.tlsCaFile) } : {}),
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
            agentVersion: "0.5.0",
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
    if (f.type === "device.command") {
      this.commandChain = this.commandChain
        .then(() => this.runCommand(b))
        .catch((e) =>
          this.log(
            "COMMAND_FAILED_" + (e instanceof Error ? e.message : "ERR"),
          ),
        );
      return;
    }
    if (f.type === "job.offer") {
      const id = b.fence.assignmentId;
      if (this.running.has(id)) return;
      if (b.jobId !== b.job.id) throw new Error("OFFER_JOB_MISMATCH");
      const usage = this.usage();
      const job = b.job;
      const canRun =
        (this.config.testExecutor && job.type === "media.transcode") ||
        (this.ffmpeg && job.type === "media.transcode") ||
        (this.hasRecognition() &&
          (job.type === "media.transcribe" || job.type === "media.subtitles"));
      const ready =
        canRun &&
        this.running.size < usage.availableSlots &&
        usage.freeDiskBytes >= job.source.bytes + job.maxOutputBytes &&
        usage.workDiskAvailable;
      if (!ready) {
        this.queue(
          frame("job.decline", {
            jobId: b.jobId,
            fence: b.fence,
            error: {
              code: canRun
                ? "RESOURCES_UNAVAILABLE"
                : job.type === "media.transcode"
                  ? "FFMPEG_UNAVAILABLE"
                  : "MODEL_NOT_INSTALLED",
              message: "Local admission is unavailable",
              permanent:
                !canRun &&
                job.type === "media.transcode" &&
                !this.config.testExecutor &&
                !this.ffmpeg,
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
        stage: "WAITING_SOURCE",
        transferAbort: new AbortController(),
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
      const r = [...this.running.values()].find((x) => x.acks.has(b.replyTo));
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
      if (held) {
        if (!failed)
          this.queue(frame("job.stopped", { jobId: b.jobId, fence: b.fence }));
        this.releaseHeld(held);
      }
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
      if (!r.attempt.started) {
        r.attempt.started = true;
        this.journal.save();
        if (this.config.testExecutor) this.startTest(r);
        else this.startJob(r);
      } else r.executor?.renew(this.config.testDurationMs, r.lease);
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
  startJob(r: Running) {
    void this.runJob(r).catch((e) => {
      if (r.ending) return;
      const err = e instanceof TransferError ? e : null;
      return this.finish(
        r,
        errorCode(e, "JOB_FAILED"),
        false,
        err?.permanent ?? true,
      ).catch(() => this.close());
    });
  }
  async runCommand(cmd: {
    requestId: string;
    type: string;
    modelId?: string;
    modelRevision?: string;
  }) {
    let lastReport = 0;
    const report = (
      status: "RUNNING" | "SUCCEEDED" | "FAILED",
      progress: number | null,
      error?: { code: string; message: string; permanent: boolean },
    ) => {
      if (
        status === "RUNNING" &&
        progress !== 0 &&
        progress !== 1 &&
        Date.now() - lastReport < 500
      )
        return;
      lastReport = Date.now();
      this.queue(
        frame("device.command.result", {
          requestId: cmd.requestId,
          status,
          progress,
          ...(error ? { error } : {}),
        }),
      );
    };
    try {
      report("RUNNING", 0);
      if (["MODEL_INSTALL", "MODEL_ACTIVATE"].includes(cmd.type)) {
        const entry = lookupCatalog(
          this.journal.state.catalog,
          cmd.modelId!,
          cmd.modelRevision!,
        );
        if (entry?.executor === "catalog-test" && !this.config.allowTestModels)
          throw new Error("TEST_MODEL_FORBIDDEN");
      }
      if (cmd.type === "MODEL_INSTALL") {
        if (
          this.running.size &&
          this.journal.state.models.some(
            (m) => m.id === cmd.modelId && m.revision === cmd.modelRevision,
          )
        )
          throw new Error("MODEL_IN_USE");
        if (!this.usage().workDiskAvailable)
          throw new Error("WORK_DISK_UNAVAILABLE");
        await installModel(
          this.config.workDir,
          this.journal,
          this.journal.state.catalog,
          cmd.modelId!,
          cmd.modelRevision!,
          this.usage().freeDiskBytes,
          (n) => report("RUNNING", n),
        );
      } else if (cmd.type === "MODEL_ACTIVATE") {
        this.readiness.clear();
        activateModel(
          this.journal,
          cmd.modelId!,
          cmd.modelRevision!,
          this.config.whisperCpp,
          this.config.ffmpeg,
        );
      } else if (cmd.type === "MODEL_DELETE") {
        deleteModel(
          this.config.workDir,
          this.journal,
          cmd.modelId!,
          cmd.modelRevision!,
          this.running.size > 0,
        );
      } else if (cmd.type === "CONFIGURE") {
        await applyConfigure(this, (cmd as any).settings);
      } else throw new Error("UNKNOWN_COMMAND");
      report("SUCCEEDED", 1);
    } catch (e) {
      const code = errorCode(e, "COMMAND_FAILED");
      report("FAILED", null, {
        code,
        message: "Device command failed: " + code,
        permanent: code !== "INSUFFICIENT_DISK",
      });
    }
  }
  async runJob(r: Running) {
    const job = r.job || r.attempt.job;
    if (!job || !["FILE", "HLS"].includes(job.source.kind))
      throw new TransferError(
        "UNSUPPORTED_SOURCE",
        "Unsupported source kind",
        false,
        true,
      );
    if (!r.lease.valid())
      throw new TransferError("LEASE_EXPIRED", "Lease expired", false, true);
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
    let dest = join(dir, "source.bin");
    r.progress = 0.05;
    r.stage = "DOWNLOADING";
    if (job.source.kind === "HLS") {
      const sourceDir = join(dir, "source");
      for (const part of job.source.files) {
        if (!/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/.test(part.path))
          throw new Error("INVALID_HLS_INPUT");
        const path = join(sourceDir, part.path);
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        await this.transfer(part.path, "GET", r, (link) =>
          downloadLink(
            link,
            path,
            part.bytes,
            part.sha256,
            undefined,
            undefined,
            r.transferAbort?.signal,
          ),
        );
      }
      dest = validateHlsInput(
        sourceDir,
        job.source.files.map((p: any) => p.path),
      );
    } else {
      await this.transfer("source", "GET", r, (link) =>
        downloadLink(
          link,
          dest,
          job.source.bytes,
          job.source.sha256,
          undefined,
          undefined,
          r.transferAbort?.signal,
        ),
      );
    }
    if (!r.lease.valid())
      throw new TransferError("LEASE_EXPIRED", "Lease expired", false, true);
    const files: {
      path: string;
      bytes: number;
      sha256: string;
      contentType: string;
      kind: string;
      language?: string;
    }[] = [];
    const steps: any[] = [];
    let packaged: any;
    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    if (job.type === "media.transcode") {
      r.stage = "TRANSCODING";
      const hlsDir = join(outDir, "hls");
      await new Promise<void>((resolve, reject) => {
        r.executor = new Executor(
          3600000,
          r.lease,
          (m) => {
            if (r.ending) return;
            if (m.type === "progress") {
              r.progress = 0.1 + Math.min(0.5, (m.progress || 0) * 0.5);
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
            outDir: hlsDir,
            profile: job.params.profile,
            maxDurationSeconds: job.maxDurationSeconds,
            maxOutputBytes: job.maxOutputBytes,
            ffmpeg: this.config.ffmpeg,
            ffprobe: this.config.ffprobe,
          },
        );
        r.executor.child.once("exit", () => {
          if (!packaged && !r.ending) reject(new Error("EXECUTOR_EXITED"));
        });
      });
      files.push(...(await listPackage(hlsDir)));
      steps.push({ name: "video", status: "SUCCEEDED" });
    }
    const speechParams =
      job.params?.subtitles?.speech || job.params?.speech || job.params || {};
    const wantSubs =
      job.type === "media.subtitles" ||
      job.type === "media.transcribe" ||
      job.params?.subtitles ||
      job.params?.includeOriginal ||
      job.params?.targetLanguages;
    if (wantSubs || job.type === "media.transcribe") {
      await this.addSpeech(
        r,
        job,
        dest,
        dir,
        outDir,
        files,
        steps,
        speechParams,
      );
    }
    let total = 0;
    for (const file of files) total += file.bytes;
    if (total > job.maxOutputBytes)
      throw new TransferError(
        "OUTPUT_LIMIT",
        "Package exceeds maxOutputBytes",
        false,
        true,
      );
    if (!files.length)
      throw new TransferError(
        "EMPTY_ARTIFACT",
        "No output files were produced",
        false,
        true,
      );
    const manifest: any = { files, steps };
    if (job.type === "media.transcode") {
      manifest.masterPath = "index.m3u8";
      manifest.renditions = packaged.renditions;
    }
    const detected = steps.find(
      (s: any) => s.name === "transcript" && s.status === "SUCCEEDED",
    );
    if (detected?.language) manifest.detectedLanguage = detected.language;
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
    r.stage = "UPLOADING";
    for (const file of files) {
      const disk =
        file.kind === "MASTER" ||
        file.kind === "PLAYLIST" ||
        file.kind === "SEGMENT"
          ? join(outDir, "hls", file.path)
          : join(outDir, file.path);
      await this.transfer(file.path, "PUT", r, (link) =>
        uploadLink(link, disk, undefined, undefined, r.transferAbort?.signal),
      );
    }
    r.attempt.awaitingPublication = true;
    r.attempt.started = true;
    r.stage = "WAITING_PUBLICATION";
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
  async speechTask(r: Running, payload: object): Promise<any> {
    if (r.ending || !r.lease.valid()) throw new Error("LEASE_EXPIRED");
    if (r.executor) await r.executor.stop();
    if (r.ending || !r.lease.valid()) throw new Error("LEASE_EXPIRED");
    return new Promise((resolve, reject) => {
      let settled = false;
      const executor = new Executor(
        0,
        r.lease,
        (m) => {
          if (m.type === "speech-result" && !r.ending && r.lease.valid()) {
            settled = true;
            r.activity++;
            r.lastProgress = Date.now();
            resolve(m.result);
          } else if (m.type === "failed" || m.type === "executor-error") {
            settled = true;
            reject(new Error(m.code || "SPEECH_EXECUTOR_FAILED"));
          }
        },
        new URL("./speech-child.js", import.meta.url),
        payload,
      );
      r.executor = executor;
      executor.child.once("exit", () => {
        if (!settled)
          reject(new Error(r.ending ? "CANCELLED" : "SPEECH_EXECUTOR_EXITED"));
      });
    });
  }
  async addSpeech(
    r: Running,
    job: any,
    source: string,
    dir: string,
    outDir: string,
    files: any[],
    steps: any[],
    speechParams: any,
  ) {
    const nested = job.params?.subtitles;
    const includeOriginal = Boolean(
      job.params?.includeOriginal ?? nested?.includeOriginal,
    );
    const targets: string[] = [
      ...(job.params?.targetLanguages || nested?.targetLanguages || []),
    ];
    if (job.type === "media.transcode" && !includeOriginal && !targets.length)
      return;
    r.stage = "TRANSCRIBING";
    let transcript: Transcript;
    try {
      if (!this.hasRecognition()) throw new Error("MODEL_NOT_INSTALLED");
      const model = selectRecognition(
        this.journal.state.models,
        speechParams.mode || "AUTO",
        this.usage().freeMemoryBytes,
      );
      transcript = await this.speechTask(r, {
        operation: "recognize",
        source,
        model,
        dir,
        requested: speechParams.sourceLanguage || "auto",
        whisperCpp: this.config.whisperCpp,
        ffmpeg: this.config.ffmpeg,
        ffprobe: this.config.ffprobe,
        maxDurationSeconds: job.maxDurationSeconds,
        maxAudioBytes: this.usage().freeDiskBytes,
      });
      steps.push({
        name: "transcript",
        language: transcript.language,
        status: "SUCCEEDED",
      });
    } catch (e) {
      const code = errorCode(e, "TRANSCRIBE_FAILED");
      const err = {
        code,
        message: "Speech recognition failed",
        permanent: code === "MODEL_NOT_INSTALLED",
      };
      if (job.type === "media.transcode") {
        for (const lang of targets)
          steps.push({
            name: "subtitles",
            language: lang,
            status: "FAILED",
            error: err,
          });
        return;
      }
      throw new TransferError(code, err.message, false, err.permanent);
    }
    if (job.type === "media.transcribe") {
      const path = "transcript.txt";
      writeUtf8(join(outDir, path), transcript.text);
      files.push(
        await fileEntry(
          join(outDir, path),
          path,
          "TRANSCRIPT",
          "text/plain",
          transcript.language,
        ),
      );
      return;
    }
    r.stage = "TRANSLATING";
    mkdirSync(join(outDir, "subtitles"), { recursive: true, mode: 0o700 });
    const writeTrack = async (lang: string, cues: Cue[]) => {
      const path = "subtitles/" + lang + ".vtt";
      writeUtf8(join(outDir, path), cuesToVtt(cues));
      files.push(
        await fileEntry(join(outDir, path), path, "SUBTITLE", "text/vtt", lang),
      );
    };
    if (
      includeOriginal ||
      (job.type === "media.subtitles" && !targets.length)
    ) {
      await writeTrack(transcript.language, transcript.cues);
      steps.push({
        name: "subtitles",
        language: transcript.language,
        status: "SUCCEEDED",
      });
    }
    for (const lang of targets) {
      if (lang === transcript.language) {
        if (!files.some((f) => f.kind === "SUBTITLE" && f.language === lang)) {
          await writeTrack(lang, transcript.cues);
          steps.push({
            name: "subtitles",
            language: lang,
            status: "SUCCEEDED",
          });
        }
        continue;
      }
      try {
        const model = selectTranslation(
          this.journal.state.models,
          transcript.language,
          lang,
        );
        if (!model) throw new Error("TRANSLATION_UNAVAILABLE");
        const cues: Cue[] = await this.speechTask(r, {
          operation: "translate",
          cues: transcript.cues,
          source: transcript.language,
          target: lang,
          model,
        });
        await writeTrack(lang, cues);
        steps.push({ name: "subtitles", language: lang, status: "SUCCEEDED" });
      } catch (e) {
        const code = errorCode(e, "TRANSLATE_FAILED");
        steps.push({
          name: "subtitles",
          language: lang,
          status: "FAILED",
          error: {
            code,
            message: "Subtitle translation failed for " + lang,
            permanent: false,
          },
        });
      }
    }
  }
  durable(r: Running, f: Frame) {
    if (r.ending || !r.lease.valid())
      return Promise.reject(new Error("LEASE_EXPIRED"));
    r.acks.add(f.messageId);
    this.queue(f);
    return until(() => !r.acks.has(f.messageId) || r.ending, 120000).then(
      () => {
        if (r.ending || r.acks.has(f.messageId)) throw new Error("ACK_TIMEOUT");
      },
    );
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
  async waitLink(
    r: Running,
    path: string,
    method: "GET" | "PUT",
  ): Promise<Link> {
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
  async finish(r: Running, code: string, stopped = false, permanent = false) {
    if (r.ending) return;
    r.ending = true;
    r.transferAbort?.abort();
    if (r.executor) await r.executor.stop();
    this.running.delete(r.attempt.fence.assignmentId);
    if (stopped)
      this.journal.state.attempts = this.journal.state.attempts.filter(
        (a) => a.fence.assignmentId !== r.attempt.fence.assignmentId,
      );
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
    this.sweep();
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
      assertWorkVolume(this.config.workDir, this.journal);
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
        : r.stage || (r.executor ? "TRANSCODING" : "WAITING_SOURCE"),
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
async function applyConfigure(agent: Agent, settings: any) {
  if (!settings || typeof settings.workDirectory !== "string")
    throw new Error("INVALID_SETTINGS");
  const th = Math.min(
    settings.cpuThresholdPercent,
    settings.memoryThresholdPercent,
    settings.diskThresholdPercent,
  );
  if (
    !Number.isInteger(settings.maxParallel) ||
    settings.maxParallel < 1 ||
    settings.maxParallel > 64 ||
    [
      settings.cpuThresholdPercent,
      settings.memoryThresholdPercent,
      settings.diskThresholdPercent,
    ].some((n) => !Number.isInteger(n) || n < 1 || n > 80) ||
    th < 1 ||
    th > 80
  )
    throw new Error("INVALID_SETTINGS");
  const nextDir = resolve(settings.workDirectory);
  let nextVolume: { path: string; dev: number; ino: number } | undefined;
  if (nextDir !== agent.config.workDir) {
    if (agent.journal.state.models.length)
      throw new Error("WORK_DIRECTORY_HAS_MODELS");
    if (agent.running.size || agent.journal.state.attempts.length)
      throw new Error("DEVICE_BUSY");
    const path = realpathSync(nextDir);
    const s = statSync(path);
    if (!s.isDirectory()) throw new Error("WORK_DIRECTORY_REQUIRED");
    nextVolume = { path, dev: s.dev, ino: s.ino };
  }
  await setAutostart(agent.config, Boolean(settings.autostart), agent.token);
  if (nextVolume) {
    agent.journal.state.workVolume = nextVolume;
    agent.config.workDir = nextDir;
  }
  agent.config.paused = Boolean(settings.paused);
  agent.config.maxParallel = settings.maxParallel;
  agent.config.threshold = th;
  agent.config.cpuThresholdPercent = settings.cpuThresholdPercent;
  agent.config.memoryThresholdPercent = settings.memoryThresholdPercent;
  agent.config.diskThresholdPercent = settings.diskThresholdPercent;
  agent.journal.state.autostart = Boolean(settings.autostart);
  agent.journal.state.appliedSettings = settings;
  agent.journal.save();
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
async function fileEntry(
  full: string,
  path: string,
  kind: string,
  contentType: string,
  language?: string,
) {
  return {
    path,
    bytes: statSync(full).size,
    sha256: await sha256File(full),
    contentType,
    kind,
    ...(language ? { language } : {}),
  };
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
