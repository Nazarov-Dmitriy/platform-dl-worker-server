// Explicit, opt-in check with real public models. No dispatcher or site connection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Journal } from "../dist/journal.js";
import { bundledCatalog } from "../dist/catalog.js";
import { installModel, modelReady } from "../dist/models.js";
import { LeaseClock } from "../dist/lease.js";
import { Executor } from "../dist/executor.js";
const work = resolve(
  process.env.MODEL_SMOKE_WORK_DIR || "../tmp/real-model-smoke",
);
const whisperCpp = process.env.WHISPER_CPP;
if (!whisperCpp)
  throw new Error("WHISPER_CPP_REQUIRED: absolute path to whisper-cli");
mkdirSync(work, { recursive: true });
const journal = new Journal(join(work, "state"));
async function model(id) {
  const entry = bundledCatalog.find((m) => m.id === id);
  const cached = journal.state.models.find(
    (m) =>
      m.id === id && m.revision === entry.revision && modelReady(m, whisperCpp),
  );
  return (
    cached ||
    installModel(work, journal, [], id, entry.revision, 1e10, () => {})
  );
}
async function run(payload) {
  const lease = new LeaseClock();
  lease.sent("smoke");
  lease.grant("smoke", 120, 5);
  let executor,
    received = false;
  try {
    const result = await new Promise((accept, reject) => {
      executor = new Executor(
        0,
        lease,
        (m) => {
          if (m.type === "speech-result") {
            received = true;
            accept(m.result);
          } else if (m.type === "failed" || m.type === "executor-error") {
            received = true;
            reject(new Error(m.code));
          }
        },
        new URL("../dist/speech-child.js", import.meta.url),
        payload,
      );
      executor.child.once("exit", () => {
        if (!received) reject(new Error("SPEECH_EXECUTOR_EXITED"));
      });
    });
    await executor.closed;
    return result;
  } finally {
    await executor?.stop();
  }
}
const res = await fetch(
  "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.7.6/samples/jfk.wav",
  { signal: AbortSignal.timeout(30000) },
);
if (!res.ok) throw new Error("SAMPLE_DOWNLOAD_FAILED");
const bytes = Buffer.from(await res.arrayBuffer());
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
);
const source = join(work, "jfk.wav");
writeFileSync(source, bytes);
const transcript = await run({
  operation: "recognize",
  model: await model("whisper-cpp-base"),
  source,
  dir: work,
  requested: "auto",
  whisperCpp,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
});
assert.equal(transcript.language, "en");
assert.match(transcript.text, /country/i);
assert.ok(transcript.cues.length);
console.log(
  JSON.stringify({
    check: "recognition",
    language: transcript.language,
    text: transcript.text,
  }),
);
for (const [source, target, text] of [
  ["en", "ru", "Hello, how are you?"],
  ["ru", "en", "Привет, как дела?"],
]) {
  const translated = await run({
    operation: "translate",
    model: await model(`opus-mt-${source}-${target}-q8`),
    source,
    target,
    cues: [{ start: 1.25, end: 3.75, text }],
  });
  assert.equal(translated[0].start, 1.25);
  assert.equal(translated[0].end, 3.75);
  assert.ok(translated[0].text);
  assert.notEqual(translated[0].text, text);
  if (target === "ru") assert.match(translated[0].text, /[А-Яа-я]/);
  else assert.match(translated[0].text, /[a-z]/i);
  console.log(
    JSON.stringify({ check: "translation", source, target, cues: translated }),
  );
}
