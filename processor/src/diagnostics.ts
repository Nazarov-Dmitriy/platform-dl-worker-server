import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { frame, type Frame } from "./protocol.js";

export type DiagnosticsEvent = {
  eventId: string;
  occurredAt: string;
  source: "worker";
  service: string;
  environment?: string;
  release?: string;
  severity: "fatal" | "error" | "warning" | "info";
  code: string;
  module?: string;
  operation?: string;
  stage?: string;
  message: string;
  cause?: string;
  stack?: string;
  context?: string;
  jobId?: string;
  deviceId?: string;
};

const MAX_SPOOL = 100;
const secret =
  /(bearer\s+\S+|password\s*[=:]\s*\S+|(x-amz-signature|awsaccesskeyid|signature|token|api[_-]?key)\s*[=:]\s*[^\s&"']+|sk-[a-zA-Z0-9]{8,})/gi;
const signedURL = /https?:\/\/\S+/gi;

export function safeText(value: unknown, max = 400): string {
  let s = String(value ?? "");
  s = s.replace(secret, "[redacted]");
  s = s.replace(signedURL, "[url]");
  s = s.replace(/ffmpeg(\.exe)?\s+\S[\s\S]*/i, "ffmpeg [omitted]");
  s = [...s].filter((ch) => {
    const c = ch.charCodeAt(0);
    return ch === "\n" || ch === "\r" || ch === "\t" || (c >= 32 && c !== 127);
  }).join("");
  return s.trim().slice(0, max) || "(redacted)";
}

type SpoolState = {
  version: 1;
  pending: DiagnosticsEvent[];
  inflightMessageId?: string;
  inflightEventIds?: string[];
  dropped: number;
};

export class DiagnosticsSpool {
  readonly path: string;
  state: SpoolState = { version: 1, pending: [], dropped: 0 };
  constructor(
    readonly dir: string,
    readonly deviceId: string,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "diagnostics-spool.json");
    if (existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      if (raw?.version === 1 && Array.isArray(raw.pending))
        this.state = {
          version: 1,
          pending: raw.pending,
          inflightMessageId: raw.inflightMessageId,
          inflightEventIds: raw.inflightEventIds,
          dropped: Number(raw.dropped) || 0,
        };
    }
  }
  save() {
    const temp = this.path + ".new";
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
  }
  report(input: {
    code: string;
    message: string;
    cause?: string;
    module?: string;
    operation?: string;
    stage?: string;
    jobId?: string;
    stack?: string;
  }) {
    const event: DiagnosticsEvent = {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      source: "worker",
      service: "processor",
      severity: "error",
      code: safeText(input.code, 128),
      module: input.module ? safeText(input.module, 128) : undefined,
      operation: input.operation ? safeText(input.operation, 128) : undefined,
      stage: input.stage ? safeText(input.stage, 64) : undefined,
      message: safeText(input.message, 2048),
      cause: input.cause ? safeText(input.cause, 4096) : undefined,
      stack: input.stack ? safeText(input.stack, 2048) : undefined,
      jobId: input.jobId ? safeText(input.jobId, 128) : undefined,
      deviceId: this.deviceId,
    };
    if (this.state.pending.length >= MAX_SPOOL) {
      this.state.pending.shift();
      this.state.dropped += 1;
    }
    this.state.pending.push(event);
    this.save();
  }
  nextFrame(): Frame | undefined {
    if (!this.state.pending.length) return undefined;
    const events = this.state.pending.slice(0, 20);
    const f = frame("diagnostics.events", { events });
    this.state.inflightMessageId = f.messageId;
    this.state.inflightEventIds = events.map((e) => e.eventId);
    this.save();
    return f;
  }
  ack(replyTo: string, accepted: number, duplicates: number) {
    if (this.state.inflightMessageId !== replyTo) return;
    const done = new Set(this.state.inflightEventIds || []);
    if (accepted + duplicates >= done.size) {
      this.state.pending = this.state.pending.filter((e) => !done.has(e.eventId));
    }
    this.state.inflightMessageId = undefined;
    this.state.inflightEventIds = undefined;
    this.save();
  }
  fail(replyTo: string) {
    if (this.state.inflightMessageId !== replyTo) return;
    this.state.inflightMessageId = undefined;
    this.state.inflightEventIds = undefined;
    this.save();
  }
}
