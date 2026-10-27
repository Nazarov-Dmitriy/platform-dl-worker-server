import { spawnSync } from "node:child_process";
export type Mode = "auto" | "cpu" | "gpu";
export function canNvenc(ffmpeg: string): boolean {
  if (process.platform !== "win32") return false;
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "color=size=640x360:rate=1", "-frames:v", "1", "-an", "-c:v", "h264_nvenc", "-f", "null", "-"],
    { windowsHide: true, timeout: 10000, stdio: "ignore" });
  return result.status === 0;
}
export function selectVideoEncoder(mode: Mode, policy: string, nvenc: boolean) {
  if (mode === "gpu" && policy !== "HARDWARE_ALLOWED") throw Error("PROFILE_REQUIRES_CPU");
  if (mode === "gpu" && !nvenc) throw Error("GPU_UNAVAILABLE");
  return mode !== "cpu" && policy === "HARDWARE_ALLOWED" && nvenc ? "h264_nvenc" : "libx264";
}
export function videoCodecArgs(encoder: string, preset: string, crf: number, bitrate: number, threads: number) {
  return encoder === "h264_nvenc" ? ["-c:v", encoder, "-preset", "p5", "-rc", "vbr", "-cq", String(crf),
    "-b:v", bitrate + "k", "-maxrate", Math.round(bitrate * 1.5) + "k", "-bufsize", (bitrate * 3) + "k"] :
    ["-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-threads", String(threads)];
}
