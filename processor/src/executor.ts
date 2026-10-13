import { fork, execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LeaseClock } from "./lease.js";
export class Executor {
  readonly child: ChildProcess;
  stopped = false;
  closed: Promise<void>;
  constructor(
    durationMs: number,
    lease: LeaseClock,
    onMessage: (m: any) => void,
    script?: URL,
    payload?: object,
  ) {
    this.child = fork(
      fileURLToPath(script ?? new URL("./executor-child.js", import.meta.url)),
      [],
      {
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, PROCESSOR_TOKEN: undefined },
      },
    );
    this.closed = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.on("message", onMessage);
    this.child.on("error", () => onMessage({ type: "executor-error" }));
    if (payload && this.child.connected)
      this.child.send({ type: "start", ...payload }, () => {});
    this.renew(durationMs, lease);
  }
  renew(durationMs: number, lease: LeaseClock) {
    if (!this.stopped && this.child.connected)
      this.child.send(
        {
          type: "lease",
          durationMs,
          remainingMs: lease.remaining(),
          wallDeadline: lease.wallDeadline,
        },
        () => {},
      );
  }
  async stop() {
    if (this.stopped) return this.closed;
    this.stopped = true;
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null)
      return this.closed;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) =>
        execFile(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 2000 },
          () => resolve(),
        ),
      );
    } else {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
    }
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, 1000))]);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      } else child.kill("SIGKILL");
    }
    await this.closed;
  }
}
