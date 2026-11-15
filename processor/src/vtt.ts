export const maxSubtitleSourceBytes = 2097152;
export const maxSubtitleCues = 5000;
export const translationBatchCues = 16;
export const translationShapeRetries = 2;

export type VttCue = {
  id: string;
  implicitId: string;
  start: number;
  end: number;
  settings: string;
  arrowLine: string;
  text: string;
};

export type VttBlock =
  | { kind: "cue"; cue: VttCue }
  | { kind: "note" | "style" | "region" | "unknown"; raw: string };

export type VttDocument = { header: string; blocks: VttBlock[] };

export function parseStamp(value: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(value.trim());
  if (!m) throw new Error("INVALID_SUBTITLE_SOURCE");
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const frac = Number(m[4].padEnd(3, "0").slice(0, 3));
  if (![hours, minutes, seconds, frac].every(Number.isFinite) || minutes > 59 || seconds > 59)
    throw new Error("INVALID_SUBTITLE_SOURCE");
  return hours * 3600 + minutes * 60 + seconds + frac / 1000;
}

export function parseVttDocument(raw: string): VttDocument {
  if (typeof raw !== "string") throw new Error("INVALID_SUBTITLE_SOURCE");
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(text, "utf8") > maxSubtitleSourceBytes)
    throw new Error("SUBTITLE_LIMIT");
  const lines = text.split("\n");
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] || ""))
    throw new Error("INVALID_SUBTITLE_SOURCE");
  let split = 1;
  while (split < lines.length && lines[split].trim() !== "") split++;
  const header = lines.slice(0, split).join("\n");
  const rest = lines.slice(split + 1).join("\n");
  const chunks = rest.split(/\n\n+/).map((b) => b.replace(/\n+$/, "")).filter((b) => b.trim());
  const blocks: VttBlock[] = [];
  let cueIndex = 0;
  for (const chunk of chunks) {
    const first = chunk.split("\n")[0] || "";
    if (/^NOTE(?:\s|$)/.test(first)) {
      blocks.push({ kind: "note", raw: chunk });
      continue;
    }
    if (first === "STYLE") {
      blocks.push({ kind: "style", raw: chunk });
      continue;
    }
    if (first === "REGION") {
      blocks.push({ kind: "region", raw: chunk });
      continue;
    }
    const cue = parseCueBlock(chunk, cueIndex);
    if (!cue) {
      blocks.push({ kind: "unknown", raw: chunk });
      continue;
    }
    blocks.push({ kind: "cue", cue });
    cueIndex++;
  }
  if (cueIndex === 0) throw new Error("INVALID_SUBTITLE_SOURCE");
  if (cueIndex > maxSubtitleCues) throw new Error("SUBTITLE_LIMIT");
  return { header, blocks };
}

function parseCueBlock(chunk: string, index: number): VttCue | undefined {
  const lines = chunk.split("\n");
  const timeIndex = lines.findIndex((l) => /-->/.test(l));
  if (timeIndex < 0) return undefined;
  const arrowLine = lines[timeIndex];
  const timing = /^(.*?)\s+-->\s+(\S+)\s*(.*)$/.exec(arrowLine.trim());
  if (!timing) throw new Error("INVALID_SUBTITLE_SOURCE");
  const start = parseStamp(timing[1]);
  const end = parseStamp(timing[2]);
  if (end < start) throw new Error("INVALID_SUBTITLE_SOURCE");
  const id = lines.slice(0, timeIndex).join("\n").trim();
  const implicitId = id || `cue-${index + 1}`;
  return {
    id,
    implicitId,
    start,
    end,
    settings: timing[3].trim(),
    arrowLine,
    text: lines.slice(timeIndex + 1).join("\n"),
  };
}

export function serializeVttDocument(doc: VttDocument): string {
  const parts = [doc.header, ""];
  for (const block of doc.blocks) {
    if (block.kind !== "cue") {
      parts.push(block.raw, "");
      continue;
    }
    const cue = block.cue;
    if (cue.id) parts.push(cue.id);
    parts.push(cue.arrowLine);
    parts.push(cue.text);
    parts.push("");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

export function listCues(doc: VttDocument): VttCue[] {
  return doc.blocks.filter((b): b is { kind: "cue"; cue: VttCue } => b.kind === "cue").map((b) => b.cue);
}

export function translationPayloads(cues: VttCue[]) {
  return cues.map((c) => ({ id: c.implicitId, text: c.text }));
}

export function applyTranslatedCues(doc: VttDocument, translated: { id: string; text: string }[]): VttDocument {
  const cues = listCues(doc);
  if (translated.length !== cues.length) throw new Error("TRANSLATION_SHAPE_MISMATCH");
  const texts = new Map<string, string>();
  for (let i = 0; i < cues.length; i++) {
    const item = translated[i];
    if (!item || item.id !== cues[i].implicitId) throw new Error("TRANSLATION_SHAPE_MISMATCH");
    if (typeof item.text !== "string") throw new Error("TRANSLATION_SHAPE_MISMATCH");
    if (cues[i].text.trim() && !item.text.trim()) throw new Error("EMPTY_TRANSLATION");
    texts.set(cues[i].implicitId, item.text);
  }
  return {
    header: doc.header,
    blocks: doc.blocks.map((block) => {
      if (block.kind !== "cue") return block;
      return { kind: "cue", cue: { ...block.cue, text: texts.get(block.cue.implicitId) ?? block.cue.text } };
    }),
  };
}

export function cloneDocument(doc: VttDocument): VttDocument {
  return JSON.parse(JSON.stringify(doc));
}
