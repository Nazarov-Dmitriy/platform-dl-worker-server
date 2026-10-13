import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { allowedModelURL, lookupCatalog, type ModelEntry } from "./catalog.js";
import { modelsDir } from "./files.js";
import type { Journal, InstalledModel } from "./journal.js";
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
  const entry = lookupCatalog(extra, id, revision);
  if (!entry) throw new Error("MODEL_NOT_IN_CATALOG");
  if (!allowedModelURL(entry.downloadUrl)) throw new Error("MODEL_URL_FORBIDDEN");
  if (freeDisk < entry.downloadBytes + 8 * 1024 ** 2)
    throw new Error("INSUFFICIENT_DISK");
  const dir = join(modelsDir(workDir), id, revision);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, "payload");
  const res = await fetch(entry.downloadUrl, { redirect: "error" });
  if (!res.ok || !res.body)
    throw new Error("MODEL_DOWNLOAD_FAILED");
  onProgress(0.1);
  await pipeline(res.body as any, createWriteStream(dest));
  const file = await stat(dest);
  if (file.size !== entry.downloadBytes) {
    rmSync(dest, { force: true });
    throw new Error("MODEL_SIZE_MISMATCH");
  }
  if ((await sha256File(dest)) !== entry.sha256) {
    rmSync(dest, { force: true });
    throw new Error("MODEL_HASH_MISMATCH");
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
  return installed;
}

export function activateModel(journal: Journal, id: string, revision: string) {
  const model = journal.state.models.find(
    (m) => m.id === id && m.revision === revision,
  );
  if (!model || !existsSync(model.path)) throw new Error("MODEL_NOT_INSTALLED");
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
  if (busy) throw new Error("MODEL_IN_USE");
  journal.state.models = journal.state.models.filter(
    (m) => !(m.id === id && m.revision === revision),
  );
  journal.save();
  const dir = join(modelsDir(workDir), id, revision);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
