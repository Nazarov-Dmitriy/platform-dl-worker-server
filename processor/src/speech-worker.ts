import { execFileSync } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import {
  extractAudio,
  transcribeSource,
  translateCues,
  wavPath,
} from "./speech.js";
try {
  const w = workerData;
  let result;
  if (w.operation === "recognize") {
    let input = w.source;
    if (w.model.executor === "whisper.cpp") {
      const probe = JSON.parse(
        execFileSync(
          w.ffprobe || "ffprobe",
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            w.source,
          ],
          {
            windowsHide: true,
            timeout: 30000,
            encoding: "utf8",
            maxBuffer: 1048576,
          },
        ),
      );
      const duration = Number(probe.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("INVALID_MEDIA_DURATION");
      if (w.maxDurationSeconds && duration > w.maxDurationSeconds)
        throw new Error("DURATION_LIMIT");
      if (
        w.maxAudioBytes !== undefined &&
        duration * 32000 + 65536 > w.maxAudioBytes
      )
        throw new Error("INSUFFICIENT_DISK");
      input = wavPath(w.dir);
      extractAudio(w.ffmpeg, w.source, input, w.cpuThreads || 2);
    }
    result = transcribeSource(input, w.model, w.requested, w.whisperCpp, w.audioMode || "auto", w.cpuThreads || 2);
  } else if (w.operation === "translate") {
    if (w.model.executor === "transformers-js") {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useFSCache = false;
      const translator = await pipeline("translation", w.model.path, {
        local_files_only: true,
        dtype: "q8",
        device: "cpu",
      });
      result = [];
      try {
        for (const cue of w.cues) {
          const output = await translator(cue.text, {
            max_new_tokens: 256,
          } as any);
          const text = (output as any)[0]?.translation_text;
          if (typeof text !== "string" || !text.trim())
            throw new Error("EMPTY_TRANSLATION");
          result.push({ ...cue, text });
        }
      } finally {
        await translator.dispose();
      }
    } else result = translateCues(w.cues, w.source, w.target, w.model);
  } else throw new Error("SPEECH_OPERATION_INVALID");
  parentPort!.postMessage({ type: "speech-result", result });
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  parentPort!.postMessage({
    type: "failed",
    code: /^[A-Z][A-Z0-9_]{1,79}$/.test(message)
      ? message
      : "SPEECH_EXECUTOR_FAILED",
  });
}
