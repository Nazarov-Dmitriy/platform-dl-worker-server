import { spawn, execFile, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { mkdirSync, openSync, readSync, closeSync, statSync, statfsSync } from "node:fs";
let child: ChildProcess | undefined, ending = false, deadline = 0, wallDeadline = 0, previousWall = Date.now(), started = false;
function stop(code = 1) {
  if (ending) return;
  ending = true;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true }, () => process.exit(code));
    setTimeout(() => process.exit(code), 1800).unref();
  } else {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    process.exit(code);
  }
}
process.on("disconnect", () => stop());
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
process.on("message", (message: any) => {
  if (message.type === "stop") stop(0);
  if (message.type === "lease") {
    if (!Number.isFinite(message.remainingMs) || message.remainingMs <= 0) return stop();
    deadline = performance.now() + message.remainingMs;
    wallDeadline = Math.min(Date.now() + message.remainingMs, message.wallDeadline);
  }
  if (message.type === "start" && !started) {
    started = true;
    void run(message).catch(error => process.send?.({ type: "failed", code: error.message || "GENERATION_FAILED" }, undefined, undefined, () => stop()));
  }
});
setInterval(() => {
  const now = Date.now();
  if (now < previousWall || deadline && (performance.now() >= deadline || now >= wallDeadline)) stop();
  previousWall = now;
}, 100).unref();
async function run(work: any) {
  mkdirSync(work.outDir, { recursive: true });
  const disk = statfsSync(work.outDir);
  if (disk.bavail * disk.bsize < work.reserveDiskBytes + work.maxOutputBytes) throw Error("INSUFFICIENT_DISK");
  const file = join(work.outDir, "image.png");
  const args = ["--diffusion-model", join(work.modelPath, "transformer/model.gguf"), "--llm", join(work.modelPath, "text_encoder/model.gguf"),
    "--vae", join(work.modelPath, "vae/model.safetensors"), "--prompt", work.inputs.prompt, "--width", String(work.inputs.width), "--height", String(work.inputs.height),
    "--seed", String(work.inputs.seed ?? -1), "--steps", String(work.steps), "--cfg-scale", "1", "--output", file,
    "--threads", String(work.cpuThreads || 2),
    "--backend", work.device.toLowerCase() === "cpu" ? "cpu" : "diffusion=" + work.device + ",te=cpu,vae=cpu"];
  if (work.reference) args.push("--ref-image", work.reference);
  if (work.device.toLowerCase() !== "cpu" && work.maxVramGiB > 0) args.push("--max-vram", String(work.maxVramGiB));
  const env = { ...process.env }; delete env.PROCESSOR_TOKEN;
  await new Promise<void>((resolve, reject) => {
    child = spawn(work.executable, args, { windowsHide: true, detached: process.platform !== "win32", cwd: work.outDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "", sequence = 0;
    const output = (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-8192);
      const matches = [...buffer.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)];
      const last = matches.at(-1);
      if (last && Number(last[2]) === work.steps) process.send?.({ type: "progress", progress: Math.min(0.99, Number(last[1]) / work.steps), sequence: ++sequence });
    };
    child.stdout?.on("data", output); child.stderr?.on("data", output);
    child.on("error", () => reject(Error("GENERATION_FAILED")));
    child.on("exit", code => code === 0 ? resolve() : reject(Error("GENERATION_FAILED")));
    setTimeout(() => stop(), Math.min(3600000, work.maxDurationSeconds * 1000)).unref();
  });
  const size = statSync(file).size;
  if (size > work.maxOutputBytes) throw Error("OUTPUT_LIMIT");
  const fd = openSync(file, "r"), header = Buffer.alloc(24);
  try { readSync(fd, header, 0, 24, 0); } finally { closeSync(fd); }
  if (size < 24 || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || header.readUInt32BE(16) !== work.inputs.width || header.readUInt32BE(20) !== work.inputs.height) throw Error("GENERATION_FAILED");
  process.send?.({ type: "generated", bytes: size }, undefined, undefined, () => stop(0));
}
