import os from "node:os";
import { realpathSync, statSync, statfsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Config } from "./config.js";
import type { Journal } from "./journal.js";
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
) {
  return !c.paused &&
    available &&
    pressure === "NORMAL" &&
    Math.max(usedMemory, cpu, disk) < c.threshold
    ? Math.min(
        c.maxParallel,
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
    return {
      cpuPercent: cpu,
      memoryUsedPercent: memory,
      memoryPressure: pressure,
      diskUsedPercent: disk,
      freeMemoryBytes: free,
      freeDiskBytes: freeDisk,
      freeVramBytes: null,
      encoderBusyPercent: null,
      availableSlots: slotBudget(
        c,
        free,
        memory,
        cpu,
        disk,
        pressure,
        available,
      ),
      paused: c.paused,
      workDiskAvailable: available,
    };
  }
}
