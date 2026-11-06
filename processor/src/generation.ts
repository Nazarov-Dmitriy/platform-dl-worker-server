import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { InstalledModel } from "./journal.js";
import { sha256Canonical } from "./jcs.js";

export function generationProfile(model: Pick<InstalledModel, "id" | "revision" | "executor">) {
  if (model.executor !== "stable-diffusion.cpp") return null;
  const flux = model.id === "flux2-klein-4b-q4";
  if (!flux && model.id !== "z-image-turbo-q4") return null;
  const parameters = [
    { key: "prompt", label: "Описание", type: "string", required: true, maxLength: 4000 },
    { key: "width", label: "Ширина", type: "integer", required: true, default: 1024, options: [512, 768, 1024] },
    { key: "height", label: "Высота", type: "integer", required: true, default: 1024, options: [512, 768, 1024] },
    { key: "seed", label: "Seed", type: "integer", required: false, default: -1, minimum: -1, maximum: 4294967295 },
  ];
  const definition = { parameters, acceptsReference: flux };
  return { id: model.id, revision: model.revision, profileRevision: sha256Canonical({ ...definition, steps: flux ? 4 : 8, executionProfile: "generation-v1" }),
    name: flux ? "FLUX.2 Klein 4B · Q4" : "Z-Image-Turbo · Q4",
    description: flux ? "Генерация по описанию или по одному изображению и описанию." : "Генерация фотографий и иллюстраций по описанию.",
    parameterCount: flux ? 4000000000 : 6000000000, ...definition };
}
export function generationInputsValid(profile: NonNullable<ReturnType<typeof generationProfile>>, inputs: any) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return false;
  const fields = profile.parameters;
  if (Object.keys(inputs).some(key => !fields.some(field => field.key === key))) return false;
  for (const field of fields) {
    const value = inputs[field.key];
    if (value === undefined) { if (field.required) return false; continue; }
    if (field.type === "string") { if (typeof value !== "string" || !value.trim() || value.includes("\0") || [...value].length > field.maxLength!) return false; }
    else if (!Number.isSafeInteger(value) || field.options && !field.options.includes(value) || field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum) return false;
  }
  return true;
}
export function generationDevice(executable?: string) {
  if (!executable || !existsSync(executable)) return null;
  try {
    const output = execFileSync(executable, ["--list-devices"], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 ** 2 });
    const expected = process.platform === "darwin" ? /^(?:metal|mtl)\d*\t/im : /^cuda\d*\t/im;
    return output.split(/\r?\n/).find(line => expected.test(line))?.split("\t")[0] || null;
  } catch { return null; }
}
export function generationReady(model: InstalledModel, executable?: string) {
  return !!generationProfile(model) && ["transformer/model.gguf", "text_encoder/model.gguf", "vae/model.safetensors"].every(file => existsSync(join(model.path, file))) && !!generationDevice(executable);
}
export function validateGenerationReference(file: string) {
  const data = readFileSync(file);
  let width = 0, height = 0;
  if (data.length >= 24 && data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) {
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16 * 1024 ** 2) throw Error("INVALID_GENERATION_REFERENCE");
}
