import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { InstalledModel } from "./journal.js";

export type Cue = { start: number; end: number; text: string };
export type Transcript = { language: string; text: string; cues: Cue[] };

export function selectRecognition(
  models: InstalledModel[],
  mode: string,
  freeMemory: number,
): InstalledModel {
  const active = models.filter(
    (m) => m.state === "ACTIVE" && m.purpose === "RECOGNITION",
  );
  if (!active.length) throw new Error("MODEL_NOT_INSTALLED");
  const tests = active.filter((m) => m.executor === "catalog-test");
  if (tests.length) return tests[0];
  const ranked = active
    .filter((m) => freeMemory >= m.minimumRamBytes)
    .sort((a, b) => a.minimumRamBytes - b.minimumRamBytes);
  if (!ranked.length) throw new Error("INSUFFICIENT_MEMORY");
  if (mode === "FAST") return ranked[0];
  if (mode === "QUALITY") return ranked[ranked.length - 1];
  const fit = [...ranked]
    .reverse()
    .find((m) => freeMemory >= m.minimumRamBytes);
  return fit || ranked[0];
}

export function selectTranslation(
  models: InstalledModel[],
  source: string,
  target: string,
): InstalledModel | undefined {
  return models.find(
    (m) =>
      m.state === "ACTIVE" &&
      m.purpose === "TRANSLATION" &&
      m.translationDirections.some(
        (p) => p.source === source && p.target === target,
      ),
  );
}

export function transcribeSource(
  source: string,
  model: InstalledModel,
  requested: string,
  whisperCpp?: string,
  mode: "auto" | "cpu" | "gpu" = "auto",
  cpuThreads = 2,
): Transcript {
  if (model.executor === "catalog-test")
    return catalogTestSpeech(source, model.path, requested);
  if (model.executor === "whisper.cpp")
    return whisperCppSpeech(source, model.path, requested, whisperCpp, mode, cpuThreads);
  throw new Error("EXECUTOR_UNAVAILABLE");
}

function catalogTestSpeech(
  source: string,
  packPath: string,
  requested: string,
): Transcript {
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  if (
    Number.isFinite(pack.delayMs) &&
    pack.delayMs > 0 &&
    pack.delayMs <= 60000
  )
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pack.delayMs);
  let body: any = {};
  try {
    body = JSON.parse(readFileSync(source, "utf8"));
  } catch {
    body = {};
  }
  const language =
    (requested !== "auto" && requested) ||
    body.language ||
    pack.language ||
    "en";
  const text = String(body.text || pack.text || "");
  const cues: Cue[] = Array.isArray(body.cues)
    ? body.cues
    : Array.isArray(pack.cues)
      ? pack.cues
      : [{ start: 0, end: 1, text }];
  if (!text) throw new Error("EMPTY_TRANSCRIPT");
  return { language, text, cues };
}

function whisperCppSpeech(
  source: string,
  modelPath: string,
  requested: string,
  bin?: string,
  mode: "auto" | "cpu" | "gpu" = "auto",
  cpuThreads = 2,
): Transcript {
  const exe = bin || "whisper-cli";
  const args = ["-m", modelPath, "-f", source, "-oj", "-np", "-t", String(cpuThreads)];
  if (mode === "cpu") args.push("-ng");
  if (mode === "gpu") {
    const probe = spawnSync(exe, ["-m", modelPath, "-f", source, "-d", "1", "-nt", "-np", "-t", String(cpuThreads)],
      { timeout: 60000, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (probe.status !== 0 || !/whisper_backend_init_gpu: using [^\n]+ backend/.test(probe.stderr || "") ||
        /failed to initialize .* backend/.test(probe.stderr || "")) throw Error("GPU_UNAVAILABLE");
  }
  if (requested && requested !== "auto") args.push("-l", requested);
  else args.push("-l", "auto");
  execFileSync(exe, args, {
    timeout: 3600000,
    windowsHide: true,
    stdio: "ignore",
  });
  const output = source + ".json";
  if (!existsSync(output)) throw new Error("EMPTY_TRANSCRIPT");
  return parseWhisperJson(JSON.parse(readFileSync(output, "utf8")), requested);
}

export function parseWhisperJson(raw: any, requested = "auto"): Transcript {
  const language =
    raw?.result?.language || (requested !== "auto" ? requested : "");
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(language))
    throw new Error("LANGUAGE_DETECTION_FAILED");
  if (!Array.isArray(raw.transcription)) throw new Error("EMPTY_TRANSCRIPT");
  const cues: Cue[] = raw.transcription
    .map((s: any) => ({
      start: Number(s.offsets?.from) / 1000,
      end: Number(s.offsets?.to) / 1000,
      text: String(s.text || "").trim(),
    }))
    .filter((c: Cue) => c.text);
  if (!cues.length) throw new Error("EMPTY_TRANSCRIPT");
  if (
    cues.some(
      (c) =>
        !Number.isFinite(c.start) ||
        !Number.isFinite(c.end) ||
        c.start < 0 ||
        c.end < c.start,
    )
  )
    throw new Error("INVALID_TRANSCRIPT_TIMESTAMPS");
  return { language, cues, text: cues.map((c) => c.text).join(" ") };
}

export function parseVtt(raw: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split(/\n/);
    const time = lines.find((l) => l.includes("-->"));
    if (!time) continue;
    const [start, end] = time.split("-->").map((s) => parseStamp(s.trim()));
    const text = lines
      .filter((l) => !l.includes("-->") && !/^\d+$/.test(l) && l !== "WEBVTT")
      .join(" ")
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function parseStamp(v: string) {
  const m = /(\d+):(\d+):(\d+)[.,](\d+)/.exec(v);
  if (!m) return 0;
  return (
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4].padEnd(3, "0").slice(0, 3)) / 1000
  );
}

export function formatStamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f, 3)}`;
}

export function cuesToVtt(cues: Cue[]) {
  return (
    "WEBVTT\n\n" +
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatStamp(c.start)} --> ${formatStamp(c.end)}\n${c.text}\n`,
      )
      .join("\n")
  );
}

export function translateCues(
  cues: Cue[],
  source: string,
  target: string,
  model: InstalledModel,
): Cue[] {
  if (source === target) return cues;
  if (model.executor === "catalog-test") {
    const pack = JSON.parse(readFileSync(model.path, "utf8"));
    if ((pack.failTargets || []).includes(target))
      throw Object.assign(new Error("TRANSLATION_UNAVAILABLE"), {
        code: "TRANSLATION_UNAVAILABLE",
      });
    const table = pack.map?.[target] || {};
    return cues.map((c) => ({
      ...c,
      text: table[c.text] || `[${target}] ${c.text}`,
    }));
  }
  throw new Error("EXECUTOR_UNAVAILABLE");
}

export function writeUtf8(path: string, text: string) {
  writeFileSync(path, text, { encoding: "utf8" });
}

export function extractAudio(ffmpeg: string, source: string, dest: string, cpuThreads = 2) {
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-protocol_whitelist",
      "file,pipe",
      "-threads", String(cpuThreads),
      "-filter_threads", "1",
      "-i",
      source,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      dest,
    ],
    { timeout: 3600000, windowsHide: true, stdio: "ignore" },
  );
  if (!existsSync(dest)) throw new Error("AUDIO_EXTRACT_FAILED");
}

export function wavPath(dir: string) {
  return join(dir, "audio.wav");
}
