import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { allowedModelURL, lookupCatalog, type ModelEntry } from "./catalog.js";
import { modelsDir } from "./files.js";
import type { Journal, InstalledModel } from "./journal.js";
import { execFileSync } from "node:child_process";
import { sha256Canonical } from "./jcs.js";
import { sha256File } from "./transfer.js";

export async function installModel(
  workDir: string,
  journal: Journal,
  extra: ModelEntry[],
  id: string,
  revision: string,
  freeDisk: number,
  onProgress: (n: number) => void,
) {
  const previous = journal.state.models.find(
    (m) => m.id === id && m.revision === revision,
  );
  const entry = lookupCatalog(extra, id, revision);
  if (!entry) throw new Error("MODEL_NOT_IN_CATALOG");
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  if (
    (entry.os && !entry.os.includes(os)) ||
    (entry.architectures && !entry.architectures.includes(arch))
  )
    throw new Error("MODEL_PLATFORM_UNSUPPORTED");
  if (
    !["whisper.cpp", "transformers-js", "catalog-test"].includes(entry.executor)
  )
    throw new Error("EXECUTOR_UNAVAILABLE");
  if (!allowedModelURL(entry.downloadUrl))
    throw new Error("MODEL_URL_FORBIDDEN");
  if (freeDisk < entry.downloadBytes + 8 * 1024 ** 2)
    throw new Error("INSUFFICIENT_DISK");
  safeModelComponent(id);
  safeModelComponent(revision);
  const dir = join(modelsDir(workDir), id, revision);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let dest = join(dir, "payload");
  if (entry.files?.length) {
    if (
      entry.files.length > 32 ||
      sha256Canonical(entry.files) !== entry.sha256 ||
      entry.files.reduce((n, f) => n + f.bytes, 0) !== entry.downloadBytes
    )
      throw new Error("MODEL_MANIFEST_INVALID");
    const seen = new Set<string>();
    for (const file of entry.files) {
      if (
        !/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/.test(file.path) ||
        seen.has(file.path)
      )
        throw new Error("MODEL_MANIFEST_INVALID");
      seen.add(file.path);
      if (!allowedModelURL(file.url)) throw new Error("MODEL_URL_FORBIDDEN");
    }
    // Install into a unique directory; an interrupted reinstall never damages
    // the active package. Journal switches only after every hash has passed.
    dest = join(dir, "package-" + randomUUID());
    try {
      let completed = 0;
      for (const file of entry.files) {
        const path = join(dest, file.path);
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        await downloadModelFile(file.url, file.bytes, file.sha256, path, (n) =>
          onProgress((completed + n * file.bytes) / entry.downloadBytes),
        );
        completed += file.bytes;
      }
    } catch (e) {
      rmSync(dest, { recursive: true, force: true });
      throw e;
    }
  } else {
    await downloadModelFile(
      entry.downloadUrl,
      entry.downloadBytes,
      entry.sha256,
      dest,
      onProgress,
    );
  }
  onProgress(1);
  const installed: InstalledModel = {
    id,
    revision,
    state: "INSTALLED",
    path: dest,
    purpose: entry.purpose,
    executor: entry.executor,
    recognitionLanguages: entry.recognitionLanguages,
    translationDirections: entry.translationDirections,
    minimumRamBytes: entry.minimumRamBytes,
  };
  journal.state.models = journal.state.models.filter(
    (m) => !(m.id === id && m.revision === revision),
  );
  journal.state.models.push(installed);
  journal.save();
  if (
    previous &&
    previous.path !== dest &&
    dirname(previous.path) === dir &&
    basename(previous.path).startsWith("package-")
  )
    rmSync(previous.path, { recursive: true, force: true });
  return installed;
}

export function modelReady(
  model: InstalledModel,
  whisperCpp?: string,
  ffmpeg = "ffmpeg",
) {
  if (!existsSync(model.path)) return false;
  if (model.executor === "catalog-test") return true;
  if (model.executor === "transformers-js")
    return [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/encoder_model_quantized.onnx",
      "onnx/decoder_model_merged_quantized.onnx",
    ].every((p) => existsSync(join(model.path, p)));
  if (model.executor !== "whisper.cpp") return false;
  try {
    execFileSync(whisperCpp || "whisper-cli", ["--help"], {
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
    execFileSync(ffmpeg, ["-version"], {
      windowsHide: true,
      timeout: 5000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
export function activateModel(
  journal: Journal,
  id: string,
  revision: string,
  whisperCpp?: string,
  ffmpeg?: string,
) {
  const model = journal.state.models.find(
    (m) => m.id === id && m.revision === revision,
  );
  if (!model || !existsSync(model.path)) throw new Error("MODEL_NOT_INSTALLED");
  if (!modelReady(model, whisperCpp, ffmpeg))
    throw new Error("EXECUTOR_UNAVAILABLE");
  model.state = "ACTIVE";
  journal.save();
}

export function deleteModel(
  workDir: string,
  journal: Journal,
  id: string,
  revision: string,
  busy: boolean,
) {
  safeModelComponent(id);
  safeModelComponent(revision);
  if (busy) throw new Error("MODEL_IN_USE");
  journal.state.models = journal.state.models.filter(
    (m) => !(m.id === id && m.revision === revision),
  );
  journal.save();
  const dir = join(modelsDir(workDir), id, revision);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function safeModelComponent(value: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error("MODEL_ID_INVALID");
}
async function fetchModel(initial: string): Promise<Response> {
  let current = new URL(initial);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!allowedModelURL(current.href) || current.username || current.password)
      throw new Error("MODEL_URL_FORBIDDEN");
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(600000),
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (!location) throw new Error("MODEL_DOWNLOAD_FAILED");
    const next = new URL(location, current);
    if (current.protocol === "https:" && next.protocol !== "https:")
      throw new Error("MODEL_URL_FORBIDDEN");
    current = next;
  }
  throw new Error("MODEL_REDIRECT_LIMIT");
}

async function downloadModelFile(
  url: string,
  bytes: number,
  sha256: string,
  dest: string,
  onProgress: (n: number) => void,
) {
  const temporary = dest + "." + randomUUID() + ".part";
  try {
    const res = await fetchModel(url);
    if (!res.ok || !res.body) throw new Error("MODEL_DOWNLOAD_FAILED");
    const length = res.headers.get("content-length");
    if (length !== null && Number(length) !== bytes) {
      await res.body.cancel();
      throw new Error("MODEL_SIZE_MISMATCH");
    }
    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > bytes) return callback(new Error("MODEL_SIZE_MISMATCH"));
        onProgress(Math.min(0.95, received / bytes));
        callback(null, chunk);
      },
    });
    await pipeline(
      res.body as any,
      limit,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if ((await stat(temporary)).size !== bytes)
      throw new Error("MODEL_SIZE_MISMATCH");
    if ((await sha256File(temporary)) !== sha256)
      throw new Error("MODEL_HASH_MISMATCH");
    renameSync(temporary, dest);
  } catch (e) {
    rmSync(temporary, { force: true });
    throw e;
  }
}

// Only called at startup under the exclusive processor lock, before installers
// and inference can run. Preserve every package referenced by the journal.
export function cleanupModelArtifacts(workDir: string, journal: Journal) {
  const root = modelsDir(workDir);
  if (!existsSync(root)) return;
  const kept = new Set(journal.state.models.map((m) => m.path));
  for (const id of readdirSync(root)) {
    const model = join(root, id);
    if (!lstatSync(model).isDirectory()) continue;
    for (const revision of readdirSync(model)) {
      const dir = join(model, revision);
      if (!lstatSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (
          !kept.has(path) &&
          (name.startsWith("package-") ||
            /^payload\.[a-f0-9-]+\.part$/.test(name))
        )
          rmSync(path, { recursive: true, force: true });
      }
    }
  }
}
