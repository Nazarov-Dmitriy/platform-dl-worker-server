import { statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
let deadline = 0,
  wallDeadline = 0,
  lastWall = Date.now(),
  stopping = false;
let worker: Worker | undefined;
let work: any;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  // The watchdog stays on this thread while inference and synchronous CLI calls
  // run in the worker. Kill the owned process tree, including ffmpeg/whisper.
  if (process.platform === "win32") {
    execFile(
      "taskkill.exe",
      ["/PID", String(process.pid), "/T", "/F"],
      { windowsHide: true, timeout: 1500 },
      () => process.exit(code),
    );
    setTimeout(() => process.exit(code), 1800).unref();
  } else {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(code);
    }
  }
}
process.on("disconnect", () => stop(1));
process.on("message", (m: any) => {
  if (m.type === "lease") {
    if (
      !Number.isFinite(m.remainingMs) ||
      m.remainingMs <= 0 ||
      !Number.isFinite(m.wallDeadline)
    )
      return stop(1);
    deadline = performance.now() + m.remainingMs;
    wallDeadline = Math.min(Date.now() + m.remainingMs, m.wallDeadline);
  } else if (m.type === "start") {
    if (
      worker ||
      !deadline ||
      performance.now() >= deadline ||
      Date.now() >= wallDeadline
    )
      return stop(1);
    work = m;
    worker = new Worker(new URL("./speech-worker.js", import.meta.url), {
      workerData: m,
    });
    worker.on("message", (result) => {
      process.send?.(result, undefined, undefined, () =>
        stop(result.type === "failed" ? 1 : 0),
      );
    });
    worker.on("error", () =>
      process.send?.(
        { type: "failed", code: "SPEECH_EXECUTOR_FAILED" },
        undefined,
        undefined,
        () => stop(1),
      ),
    );
  } else if (m.type === "stop") stop(0);
});
setInterval(() => {
  const now = Date.now();
  if (
    !deadline ||
    performance.now() >= deadline ||
    now >= wallDeadline ||
    now < lastWall - 1000
  )
    stop(1);
  lastWall = Math.max(now, lastWall);
}, 100);

setInterval(() => {
  if (stopping || !work?.dir || work.maxAudioBytes === undefined) return;
  try {
    if (statSync(join(work.dir, "audio.wav")).size > work.maxAudioBytes)
      process.send?.(
        { type: "failed", code: "INSUFFICIENT_DISK" },
        undefined,
        undefined,
        () => stop(1),
      );
  } catch {
    /* ffmpeg may not have opened its output yet. */
  }
}, 500);
