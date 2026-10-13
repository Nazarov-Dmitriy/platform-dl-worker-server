import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
function has(bin: string) {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
function pkgRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}
export function doctor(configPath?: string) {
  const pkg = JSON.parse(readFileSync(join(pkgRoot(), "package.json"), "utf8"));
  const engines = pkg.engines?.node ?? "";
  const major = Number(process.versions.node.split(".")[0]);
  const minMajor = Number((String(engines).match(/(\d+)/) || ["", "22"])[1]);
  const report: Record<string, unknown> = {
    node: process.version,
    engines: engines,
    nodeOk: major >= minMajor,
    platform: process.platform,
    arch: process.arch,
    platformOk: ["win32", "darwin", "linux"].includes(process.platform) &&
      ["x64", "arm64"].includes(process.arch),
  };
  if (configPath) {
    const config: Config = loadConfig(configPath);
    report.config = configPath;
    report.workDir = config.workDir;
    report.workDirOk = existsSync(config.workDir) && statSync(config.workDir).isDirectory();
    report.stateDir = config.stateDir;
    report.ffmpeg = has(config.ffmpeg);
    report.ffprobe = has(config.ffprobe);
    report.tokenPresent = Boolean(process.env.PROCESSOR_TOKEN && !/\s/.test(process.env.PROCESSOR_TOKEN));
  } else {
    report.ffmpeg = has("ffmpeg");
    report.ffprobe = has("ffprobe");
  }
  const req = createRequire(join(pkgRoot(), "package.json"));
  try {
    req.resolve("ws");
    report.dependencies = true;
  } catch {
    report.dependencies = false;
  }
  const ok =
    report.nodeOk === true &&
    report.platformOk === true &&
    report.dependencies === true &&
    (configPath ? report.workDirOk === true && report.ffmpeg === true && report.ffprobe === true : true);
  report.ok = ok;
  return report;
}
