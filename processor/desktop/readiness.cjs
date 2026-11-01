"use strict";
const { spawnSync, execFileSync } = require("node:child_process");

// Returns true when the binary can actually be launched. A missing file is
// ENOENT; on Windows a missing DLL (e.g. CUDA runtime) starts the process but
// exits with a large status such as 0xC0000135, so that is also treated as
// unavailable. A normal exit code (0..255) means the binary loaded and ran.
function commandAvailable(bin, args) {
  const result = spawnSync(bin, args, {
    windowsHide: true,
    stdio: "ignore",
    timeout: 8000,
  });
  if (result.error) return result.error.code !== "ENOENT";
  if (result.status !== null && (result.status < 0 || result.status > 255))
    return false;
  return true;
}

// Detect the real GPU rather than guessing by brand. nvidia-smi ships with the
// NVIDIA driver, so its presence confirms a usable CUDA path. AMD and Intel
// have no ready Windows CUDA build in the whisper.cpp release, so they fall
// back to the universal CPU build.
function detectGpu() {
  if (commandAvailable("nvidia-smi", ["-L"])) {
    let name = "NVIDIA";
    try {
      const out = execFileSync(
        "nvidia-smi",
        ["--query-gpu=name", "--format=csv,noheader"],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const first = out.trim().split(/\r?\n/)[0];
      if (first) name = first;
    } catch {}
    return { vendor: "nvidia", cuda: true, name };
  }
  let vendor = "unknown",
    name = "";
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
    name = out.trim();
    const lower = name.toLowerCase();
    if (lower.includes("nvidia")) vendor = "nvidia";
    else if (lower.includes("amd") || lower.includes("radeon")) vendor = "amd";
    else if (lower.includes("intel")) vendor = "intel";
  } catch {}
  return { vendor, cuda: false, name };
}

function videoReadiness() {
  const missing = [];
  if (!commandAvailable("ffmpeg", ["-version"])) missing.push("ffmpeg");
  if (!commandAvailable("ffprobe", ["-version"])) missing.push("ffprobe");
  return { ok: missing.length === 0, missing };
}

function speechReadiness(whisperCpp) {
  const ok = commandAvailable(whisperCpp || "whisper-cli", ["--help"]);
  return { ok, missing: ok ? [] : ["whisper-cli"] };
}

module.exports = {
  videoReadiness,
  speechReadiness,
  commandAvailable,
  detectGpu,
};

