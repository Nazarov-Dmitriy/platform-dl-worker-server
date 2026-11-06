import os from "node:os";
import { realpathSync, statSync, statfsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import type { Config } from "./config.js";
import type { Journal } from "./journal.js";

function parseNvidiaSmi(): { totalBytes: number; usedBytes: number } | null {
  try {
    const out = execFileSync(
      "nvidia-smi",
      [
        "--query-gpu=memory.total,memory.used",
        "--format=csv,noheader,nounits",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const line = out.trim().split(/\r?\n/)[0];
    if (!line) return null;
    const parts = line.split(",").map((s) => Number(s.trim()));
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
    return {
      totalBytes: Math.round(parts[0] * 1024 * 1024),
      usedBytes: Math.round(parts[1] * 1024 * 1024),
    };
  } catch {
    return null;
  }
}

function detectGpuName(): string {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '|'",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 8000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return out.trim();
    } catch {}
  }
  return "";
}
export const transcodeCapability = {
  code: "media.transcode",
  recognitionLanguages: [] as string[],
  translationDirections: [] as { source: string; target: string }[],
  autoDetect: false,
  formats: ["hls"],
  availability: "ONLINE",
  profilePolicies: ["X264_EXACT"],
};
export const testCapabilities = [transcodeCapability];
export function slotBudget(
  c: Config,
  freeMemory: number,
  usedMemory: number,
  cpu: number,
  disk: number,
  pressure: string,
  available: boolean,
  vramUsedPercent: number | null = null,
) {
  return !c.paused &&
    available &&
    pressure === "NORMAL" &&
    (vramUsedPercent === null || vramUsedPercent < (c.vramThresholdPercent ?? 80)) &&
    usedMemory < (c.memoryThresholdPercent ?? c.threshold) &&
    cpu < (c.cpuThresholdPercent ?? c.threshold) &&
    disk < (c.diskThresholdPercent ?? c.threshold)
    ? Math.min(
        c.maxParallel,
        c.localSettings ? (c.cpuThreads || c.maxParallel) : c.maxParallel,
        Math.max(
          0,
          Math.floor((freeMemory - c.reserveMemoryBytes) / c.taskMemoryBytes),
        ),
      )
    : 0;
}
export class Resources {
  previous = os.cpus();
  constructor(
    readonly config: Config,
    readonly journal: Journal,
  ) {
    // Never create workDir: a missing external volume must not fall back to the system disk.
    if (!journal.state.workVolume) {
      const path = realpathSync(config.workDir),
        s = statSync(path);
      if (!s.isDirectory()) throw new Error("WORK_DIRECTORY_REQUIRED");
      journal.state.workVolume = { path, dev: s.dev, ino: s.ino };
      journal.save();
    }
  }
  sample() {
    const c = this.config,
      cpus = os.cpus();
    let idle = 0,
      total = 0;
    for (let i = 0; i < cpus.length; i++) {
      const before = this.previous[i]?.times;
      if (!before) continue;
      idle += cpus[i].times.idle - before.idle;
      for (const key of Object.keys(before) as (keyof typeof before)[])
        total += cpus[i].times[key] - before[key];
    }
    this.previous = cpus;
    const cpu =
      total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 100;
    let free = os.freemem(),
      pressure = "NORMAL";
    if (process.platform === "linux") {
      try {
        const info = readFileSync("/proc/meminfo", "utf8");
        const m = /MemAvailable:\s+(\d+)/.exec(info);
        if (m) free = Number(m[1]) * 1024;
      } catch {
        pressure = "WARNING";
      }
    }
    if (process.platform === "darwin") {
      try {
        const info = execFileSync("/usr/bin/memory_pressure", ["-Q"], {
          timeout: 1500,
          encoding: "utf8",
        });
        const m = /free percentage:\s*(\d+)%/i.exec(info);
        if (!m) pressure = "WARNING";
        else if (Number(m[1]) < 20) pressure = "CRITICAL";
      } catch {
        pressure = "WARNING";
      }
    }
    let disk = 100,
      freeDisk = 0,
      available = false;
    try {
      const path = realpathSync(c.workDir),
        s = statSync(path),
        expected = this.journal.state.workVolume!;
      if (
        path !== expected.path ||
        s.dev !== expected.dev ||
        s.ino !== expected.ino
      )
        throw new Error("VOLUME_CHANGED");
      const f = statfsSync(path);
      freeDisk = Math.max(0, f.bavail * f.bsize - c.reserveDiskBytes);
      disk = f.blocks > 0 ? 100 * (1 - f.bavail / f.blocks) : 100;
      available = true;
    } catch {}
    const memory = 100 * (1 - free / os.totalmem());
    const gpuInfo = parseNvidiaSmi();
    const gpuName = detectGpuName();
    return {
      cpuPercent: cpu,
      memoryUsedPercent: memory,
      memoryPressure: pressure,
      diskUsedPercent: disk,
      freeMemoryBytes: free,
      freeDiskBytes: freeDisk,
      freeVramBytes: gpuInfo ? gpuInfo.totalBytes - gpuInfo.usedBytes : null,
      vramTotalBytes: gpuInfo ? gpuInfo.totalBytes : null,
      vramUsedBytes: gpuInfo ? gpuInfo.usedBytes : null,
      gpuName: gpuName || null,
      encoderBusyPercent: null,
      availableSlots: slotBudget(
        {
          ...c,
          taskMemoryBytes: Math.max(
            c.taskMemoryBytes,
            ...this.journal.state.models
              .filter((m) => m.state === "ACTIVE")
              .map((m) => m.minimumRamBytes),
          ),
        },
        free,
        memory,
        cpu,
        disk,
        pressure,
        available,
        gpuInfo && gpuInfo.totalBytes > 0 ? 100 * gpuInfo.usedBytes / gpuInfo.totalBytes : null,
      ),
      paused: c.paused,
      workDiskAvailable: available,
    };
  }
}
