import os from "node:os";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { Journal, type Attempt } from "./journal.js";
import { frame, parseFrame, sameFence, type Frame } from "./protocol.js";
import { LeaseClock } from "./lease.js";
import { Resources, testCapabilities } from "./resources.js";
import { Executor } from "./executor.js";
type Running = {
  attempt: Attempt;
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
  chain: Promise<void> = Promise.resolve();
  closePromise?: Promise<void>;
  constructor(
    readonly config: Config,
    readonly token: string,
    readonly journal: Journal,
    readonly log: (event: string) => void = console.log,
  ) {
    this.resources = new Resources(config, journal);
  }
  caps() {
    return this.config.testExecutor ? testCapabilities : [];
  }
  usage() {
    const usage = this.resources.sample();
    usage.freeDiskBytes = Math.max(
      0,
      usage.freeDiskBytes -
        [...this.running.values()].reduce((total, r) => total + r.diskBytes, 0),
    );
    return usage;
  }
  start() {
    // A process restart never recreates executors from saved PIDs or resumes media blindly.
    for (const a of [...this.journal.state.attempts])
      this.enqueueFailure(
        a,
        "PROCESSOR_RESTARTED",
        "Processor restarted; prior executor was stopped",
      );
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
            agentVersion: "0.3.0",
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
      if (
        !this.config.testExecutor ||
        this.running.size >= usage.availableSlots ||
        usage.freeDiskBytes < b.job.source.bytes + b.job.maxOutputBytes
      ) {
        this.queue(
          frame("job.decline", {
            jobId: b.jobId,
            fence: b.fence,
            error: {
              code: "RESOURCES_UNAVAILABLE",
              message: "Local admission is unavailable",
              permanent: false,
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
      };
      this.journal.state.attempts.push(attempt);
      this.journal.save();
      const r: Running = {
        attempt,
        lease: new LeaseClock(),
        progress: null,
        activity: 0,
        ending: false,
        lastRenewal: accept,
        nextRenew: Date.now() + 1000,
        lastProgress: Date.now(),
        acceptedAt: Date.now(),
        diskBytes: b.job.source.bytes + b.job.maxOutputBytes,
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
      return;
    }
    if (f.type === "protocol.error") {
      const out = this.journal.state.outbox.find(
        (out) => out.messageId === b.replyTo,
      );
      // Stale terminal attempts need no further mutation. Other failures retain the outbox.
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
    if (f.type === "lease.granted") {
      if (r.ending || !r.lease.grant(b.renewalId, b.leaseSeconds, this.safety))
        return;
      if (!r.executor) {
        r.attempt.started = true;
        this.journal.save();
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
                  m.type === "finished"
                    ? "TEST_EXECUTOR_ONLY"
                    : "EXECUTOR_FAILED",
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
      r.executor.renew(this.config.testDurationMs, r.lease);
      return;
    }
  }
  queue(f: Frame) {
    this.journal.state.outbox.push(f);
    this.journal.save();
    this.send(f);
  }
  enqueueFailure(a: Attempt, code: string, message: string) {
    this.journal.state.attempts = this.journal.state.attempts.filter(
      (x) => x.fence.assignmentId !== a.fence.assignmentId,
    );
    this.queue(
      frame("job.failed", {
        jobId: a.jobId,
        fence: a.fence,
        error: { code, message, permanent: code === "TEST_EXECUTOR_ONLY" },
      }),
    );
  }
  async finish(r: Running, code: string, stopped = false) {
    if (r.ending) return;
    r.ending = true;
    if (r.executor) await r.executor.stop();
    this.running.delete(r.attempt.fence.assignmentId);
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
      );
    this.log(code);
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
      stage: "ANALYZING",
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
      // Rights are checked even when disconnected; reconnect never extends them itself.
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
