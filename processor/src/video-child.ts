import { canNvenc, selectVideoEncoder, videoCodecArgs } from "./encoding.js";
import { setPriority, constants } from "node:os";
import { VideoProgress } from "./video-progress.js";
import { performance } from "node:perf_hooks";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  crfValue,
  decidePlan,
  masterPlaylist,
  parseProbe,
  type PlanItem,
  type Profile,
} from "./packaging.js";
let monoDeadline = 0,
  wallDeadline = 0,
  lastWall = Date.now(),
  stopping = false;
let ffmpegProc: ChildProcess | undefined;
let work: any;
let encoder = "libx264";
let threads = 2;
function exit(code = 0) {
  if (stopping) return;
  stopping = true;
  killTree(ffmpegProc);
  if (process.platform === "win32")
    execFile(
      "taskkill.exe",
      ["/PID", String(process.pid), "/T", "/F"],
      { windowsHide: true, timeout: 1500 },
      () => process.exit(code),
    );
  else {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(code);
    }
  }
  setTimeout(() => process.exit(code), 1800).unref();
}
function killTree(child?: ChildProcess) {
  if (!child?.pid) return;
  if (process.platform === "win32")
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}
process.on("disconnect", () => exit(1));
process.on("message", (m: any) => {
  if (m.type === "stop") exit(0);
  if (m.type === "lease") {
    const ms = m.remainingMs;
    if (!Number.isFinite(ms) || ms <= 0) exit(1);
    monoDeadline = performance.now() + ms;
    wallDeadline = Math.min(Date.now() + ms, m.wallDeadline);
  }
  if (m.type === "start") {
    work = m;
    void run().catch((e) => {
      process.send?.(
        {
          type: "failed",
          code:
            e instanceof Error && e.message.length < 80
              ? e.message
              : "VIDEO_PACKAGING_FAILED",
          message: e instanceof Error ? e.message : String(e),
        },
        undefined,
        undefined,
        () => exit(1),
      );
    });
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
  )
    exit(1);
  lastWall = Math.max(lastWall, wall);
}, 100);
async function run() {
  const probe = parseProbe(
    await execText(work.ffprobe, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_format",
      "-show_streams",
      "-print_format",
      "json",
      work.source,
    ]),
  );
  if (work.maxDurationSeconds && probe.duration > work.maxDurationSeconds)
    throw new Error("DURATION_LIMIT");
  const profile: Profile = work.profile;
  const plan = decidePlan(probe, profile);
  threads = Math.max(1, Math.min(1024, Number(work.cpuThreads) || 2));
  const needsEncoding = plan.some(item => item.mode === "ENCODE");
  if (needsEncoding) encoder = selectVideoEncoder(work.videoMode || "auto", profile.encoderPolicy,
    work.videoMode !== "cpu" && profile.encoderPolicy === "HARDWARE_ALLOWED" && canNvenc(work.ffmpeg));
  const renditions = [];
  let sequence = 0;
  for (const [index, item] of plan.entries()) {
    const dir = join(work.outDir, folder(item.quality));
    mkdirSync(dir, { recursive: true });
    process.send?.({ type: "encoder", encoder: item.mode === "COPY" ? "copy" : encoder });
    await runFfmpeg(item, probe, profile, work.source, dir, (fraction) => {
      sequence++;
      process.send?.({
        type: "progress",
        sequence,
        progress: (index + fraction) / plan.length,
      });
    });
    const playlist = folder(item.quality) + "/index.m3u8";
    const bytes = dirSize(dir);
    renditions.push({
      quality: item.quality,
      width: item.width,
      height: item.height,
      bandwidth: Math.max(
        1,
        Math.round((bytes * 8) / Math.max(probe.duration, 1)),
      ),
      mode: item.mode,
      playlist,
    });
  }
  writeFileSync(join(work.outDir, "index.m3u8"), masterPlaylist(renditions));
  process.send?.(
    { type: "packaged", renditions, duration: probe.duration },
    undefined,
    undefined,
    () => exit(0),
  );
}
function folder(q: string) {
  return q.replace("P", "").toLowerCase() + "p";
}
function dirSize(dir: string) {
  let n = 0;
  for (const name of readdirSync(dir)) n += statSync(join(dir, name)).size;
  return n;
}
function runFfmpeg(
  item: PlanItem,
  probe: ReturnType<typeof parseProbe>,
  profile: Profile,
  source: string,
  dir: string,
  onProgress: (fraction: number) => void,
) {
  const gop = Math.max(
    1,
    Math.round((probe.fps || 30) * profile.segmentDurationSeconds),
  );
  const args = [
    "-progress", "pipe:1", "-nostats",
    "-hide_banner",
    "-y",
    "-protocol_whitelist",
    "file,pipe",
    "-threads", String(threads),
    "-filter_threads", "1",
    "-i",
    source,
    "-map",
    "0:v:0",
  ];
  if (probe.audioCodec) args.push("-map", "0:a:0");
  if (item.mode === "COPY") {
    args.push("-c:v", "copy");
    if (probe.audioCodec === "aac") args.push("-c:a", "copy");
    else if (probe.audioCodec)
      args.push(
        "-c:a",
        "aac",
        "-ac",
        String(profile.audioChannels),
        "-b:a",
        profile.audioBitrateKbps + "k",
      );
  } else {
    args.push(
      "-vf",
      `scale=${item.width}:${item.height}:force_original_aspect_ratio=decrease,pad=${item.width}:${item.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      ...videoCodecArgs(encoder, profile.preset, crfValue(profile.crf), item.targetKbps, threads),
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(gop),
      "-keyint_min",
      String(gop),
      "-sc_threshold",
      "0",
    );
    if (probe.audioCodec)
      args.push(
        "-c:a",
        "aac",
        "-ac",
        String(profile.audioChannels),
        "-b:a",
        profile.audioBitrateKbps + "k",
      );
  }
  args.push(
    "-f",
    "hls",
    "-hls_time",
    String(profile.segmentDurationSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    join(dir, "seg_%05d.ts"),
    join(dir, "index.m3u8"),
  );
  return new Promise<void>((resolve, reject) => {
    ffmpegProc = spawn(work.ffmpeg, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    if (ffmpegProc.pid) {
      try { setPriority(ffmpegProc.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    }
    const progress = new VideoProgress(probe.duration, onProgress);
    ffmpegProc.stdout?.on("data", chunk => progress.push(chunk.toString()));
    ffmpegProc.stderr?.resume();
    ffmpegProc.on("error", reject);
    ffmpegProc.on("exit", (code) => {
      ffmpegProc = undefined;
      if (code === 0) resolve();
      else reject(new Error("FFMPEG_FAILED"));
    });
  });
}
function execText(bin: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      args,
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (e, stdout) => {
        if (e) reject(e);
        else resolve(stdout);
      },
    );
  });
}

setInterval(() => {
  if (stopping || !work?.maxOutputBytes) return;
  try {
    if (treeSize(work.outDir) > work.maxOutputBytes)
      process.send?.(
        { type: "failed", code: "OUTPUT_LIMIT" },
        undefined,
        undefined,
        () => exit(1),
      );
  } catch {
    /* The output directory may not exist yet. */
  }
}, 500);
function treeSize(dir: string): number {
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name),
      stat = statSync(path);
    bytes += stat.isDirectory() ? treeSize(path) : stat.size;
  }
  return bytes;
}
