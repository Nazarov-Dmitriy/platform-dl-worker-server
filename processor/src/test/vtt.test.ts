import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTranslatedCues,
  listCues,
  parseVttDocument,
  serializeVttDocument,
  translationPayloads,
} from "../vtt.js";
import { translateCues } from "../speech.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sample = `WEBVTT
Kind: captions

NOTE keep this comment

STYLE
::cue { color: white; }

intro
00:00:00.000 --> 00:00:01.000 align:start
Hello
world

REGION
id:fred width:40%

00:00:01.500 --> 00:00:02.000
Second

X-UNKNOWN
still here
`;

test("VTT parser keeps identifiers, timings, settings and unknown blocks", () => {
  const doc = parseVttDocument(sample);
  const cues = listCues(doc);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].id, "intro");
  assert.equal(cues[0].settings, "align:start");
  assert.equal(cues[0].text, "Hello\nworld");
  assert.match(cues[0].arrowLine, /00:00:00\.000 --> 00:00:01\.000/);
  assert.ok(doc.blocks.some((b) => b.kind === "note"));
  assert.ok(doc.blocks.some((b) => b.kind === "style"));
  assert.ok(doc.blocks.some((b) => b.kind === "region"));
  assert.ok(doc.blocks.some((b) => b.kind === "unknown"));
  const out = serializeVttDocument(doc);
  assert.match(out, /NOTE keep this comment/);
  assert.match(out, /STYLE/);
  assert.match(out, /intro\n00:00:00\.000 --> 00:00:01\.000 align:start/);
  assert.match(out, /Hello\nworld/);
  assert.match(out, /X-UNKNOWN/);
});

test("translated cues must keep ids and order", () => {
  const doc = parseVttDocument(sample);
  const cues = listCues(doc);
  const ok = applyTranslatedCues(doc, [
    { id: cues[0].implicitId, text: "Привет\nмир" },
    { id: cues[1].implicitId, text: "Второй" },
  ]);
  assert.equal(listCues(ok)[0].text, "Привет\nмир");
  assert.equal(listCues(ok)[0].id, "intro");
  assert.throws(
    () =>
      applyTranslatedCues(doc, [
        { id: cues[1].implicitId, text: "x" },
        { id: cues[0].implicitId, text: "y" },
      ]),
    /TRANSLATION_SHAPE_MISMATCH/,
  );
  assert.throws(
    () => applyTranslatedCues(doc, [{ id: cues[0].implicitId, text: "only-one" }]),
    /TRANSLATION_SHAPE_MISMATCH/,
  );
});

test("catalog-test translation reports dropped or reordered ids as failure", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vtt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pack = join(dir, "pack.json");
  writeFileSync(pack, JSON.stringify({ dropCues: true, map: {} }));
  const cues = translationPayloads(listCues(parseVttDocument(sample))).map((c) => ({
    start: 0,
    end: 1,
    ...c,
  }));
  const model = {
    id: "catalog-test-translate",
    revision: "test-1",
    state: "ACTIVE" as const,
    path: pack,
    purpose: "TRANSLATION" as const,
    executor: "catalog-test",
    recognitionLanguages: [],
    translationDirections: [{ source: "en", target: "ru" }],
    minimumRamBytes: 1,
  };
  const dropped = translateCues(cues, "en", "ru", model);
  assert.notEqual(dropped.length, cues.length);
  writeFileSync(pack, JSON.stringify({ reorderCues: true, map: {} }));
  const reordered = translateCues(cues, "en", "ru", model);
  assert.equal(reordered[0].id, cues[cues.length - 1].id);
});
