export type Pair = { source: string; target: string };
export type ModelEntry = {
  id: string;
  revision: string;
  executor: string;
  purpose: "RECOGNITION" | "TRANSLATION";
  os: string[];
  architectures: string[];
  accelerators: string[];
  recognitionLanguages: string[];
  translationDirections: Pair[];
  downloadBytes: number;
  minimumRamBytes: number;
  minimumVramBytes: number;
  sha256: string;
  downloadUrl: string;
  license: string;
  descriptionSource: string;
};

// Languages from the OpenAI Whisper multilingual tokenizer, not a site locale list.
// https://github.com/openai/whisper/blob/main/whisper/tokenizer.py
export const whisperLanguages = [
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv",
  "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no",
  "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr",
  "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
  "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu",
  "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
  "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
];

function nllbPairs(): Pair[] {
  const langs = ["en", "ru", "de", "es", "fr", "uk", "zh"];
  const out: Pair[] = [];
  for (const a of langs)
    for (const b of langs) if (a !== b) out.push({ source: a, target: b });
  return out;
}

const osAll = ["windows", "darwin", "linux"];
const arch = ["amd64", "arm64"];

export const bundledCatalog: ModelEntry[] = [
  {
    id: "whisper-cpp-base",
    revision: "ggml-base-v1.7.6",
    executor: "whisper.cpp",
    purpose: "RECOGNITION",
    os: osAll,
    architectures: arch,
    accelerators: ["cpu", "cuda", "metal"],
    recognitionLanguages: [...whisperLanguages],
    translationDirections: [],
    downloadBytes: 147964211,
    minimumRamBytes: 1 * 1024 ** 3,
    minimumVramBytes: 0,
    sha256: "60ed5e3d76e1a12f3e9afd536d6518c733dc74fa9284c3a77df5adc76cc47e27",
    downloadUrl:
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    license: "MIT",
    descriptionSource:
      "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py",
  },
  {
    id: "whisper-cpp-small",
    revision: "ggml-small-v1.7.6",
    executor: "whisper.cpp",
    purpose: "RECOGNITION",
    os: osAll,
    architectures: arch,
    accelerators: ["cpu", "cuda", "metal"],
    recognitionLanguages: [...whisperLanguages],
    translationDirections: [],
    downloadBytes: 487601967,
    minimumRamBytes: 2 * 1024 ** 3,
    minimumVramBytes: 0,
    sha256: "1be3a9b2063867b937e64e2ec7483364a152123cbd738e99835de1eb5394d21a",
    downloadUrl:
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    license: "MIT",
    descriptionSource:
      "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py",
  },
  {
    id: "nllb-200-distilled-600m-int8",
    revision: "ct2-2024-01",
    executor: "nllb-ct2",
    purpose: "TRANSLATION",
    os: osAll,
    architectures: arch,
    accelerators: ["cpu", "cuda"],
    recognitionLanguages: [],
    translationDirections: nllbPairs(),
    downloadBytes: 600000000,
    minimumRamBytes: 3 * 1024 ** 3,
    minimumVramBytes: 0,
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    downloadUrl: "https://huggingface.co/facebook/nllb-200-distilled-600M",
    license: "CC-BY-NC-4.0",
    descriptionSource: "https://huggingface.co/facebook/nllb-200-distilled-600M",
  },
];

export function lookupCatalog(
  extra: ModelEntry[],
  id: string,
  revision: string,
): ModelEntry | undefined {
  return [...extra, ...bundledCatalog].find(
    (m) => m.id === id && m.revision === revision,
  );
}

export function allowedModelURL(raw: string) {
  const url = new URL(raw);
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}
