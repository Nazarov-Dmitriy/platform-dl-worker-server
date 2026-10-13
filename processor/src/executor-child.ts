import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
// Independent watchdog: continues to run if the processor's event loop stalls.
let monoDeadline = 0,
  wallDeadline = 0,
  lastWall = Date.now(),
  duration = 0,
  started = 0,
  sequence = 0;
let stopping = false;
function exit() {
  if (stopping) return;
  stopping = true;
  // This process owns its Unix group. Windows taskkill targets this live process,
  // never a PID recovered from disk. The same boundary will own FFmpeg in stage 4.
  if (process.platform === "win32")
    execFile(
      "taskkill.exe",
      ["/PID", String(process.pid), "/T", "/F"],
      { windowsHide: true, timeout: 1500 },
      () => process.exit(0),
    );
  else {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(0);
    }
  }
  setTimeout(() => process.exit(0), 1800).unref();
}
process.on("disconnect", exit);
process.on("message", (m: any) => {
  if (m.type === "stop") exit();
  if (m.type === "lease") {
    const ms = m.remainingMs;
    if (!Number.isFinite(ms) || ms <= 0) exit();
    monoDeadline = performance.now() + ms;
    wallDeadline = Math.min(Date.now() + ms, m.wallDeadline);
    duration = m.durationMs;
    if (!started) started = performance.now();
  }
});
setInterval(() => {
  const wall = Date.now();
  if (stopping) return;
  if (
    !monoDeadline ||
    performance.now() >= monoDeadline ||
    wall >= wallDeadline ||
    wall < lastWall - 1000
  ) {
    exit();
    return;
  }
  lastWall = Math.max(lastWall, wall);
  if (process.connected) {
    sequence++;
    process.send?.({
      type: "progress",
      sequence,
      progress: Math.min(0.99, (performance.now() - started) / duration),
    });
  }
  if (started && performance.now() - started >= duration) {
    process.send?.({ type: "finished" }, undefined, undefined, () => exit());
  }
}, 100);
