import { readFileSync } from "node:fs";
export type Pair = { source: string; target: string };
export type ModelFile = {
  path: string;
  bytes: number;
  sha256: string;
  url: string;
};
export type ModelEntry = {
  files?: ModelFile[];
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
  "en",
  "zh",
  "de",
  "es",
  "ru",
  "ko",
  "fr",
  "ja",
  "pt",
  "tr",
  "pl",
  "ca",
  "nl",
  "ar",
  "sv",
  "it",
  "id",
  "hi",
  "fi",
  "vi",
  "he",
  "uk",
  "el",
  "ms",
  "cs",
  "ro",
  "da",
  "hu",
  "ta",
  "no",
  "th",
  "ur",
  "hr",
  "bg",
  "lt",
  "la",
  "mi",
  "ml",
  "cy",
  "sk",
  "te",
  "fa",
  "lv",
  "bn",
  "sr",
  "az",
  "sl",
  "kn",
  "et",
  "mk",
  "br",
  "eu",
  "is",
  "hy",
  "ne",
  "mn",
  "bs",
  "kk",
  "sq",
  "sw",
  "gl",
  "mr",
  "pa",
  "si",
  "km",
  "sn",
  "yo",
  "so",
  "af",
  "oc",
  "ka",
  "be",
  "tg",
  "sd",
  "gu",
  "am",
  "yi",
  "lo",
  "uz",
  "fo",
  "ht",
  "ps",
  "tk",
  "nn",
  "mt",
  "sa",
  "lb",
  "my",
  "bo",
  "tl",
  "mg",
  "as",
  "tt",
  "haw",
  "ln",
  "ha",
  "ba",
  "jw",
  "su",
  "yue",
];

const osAll = ["windows", "darwin", "linux"];
const arch = ["amd64", "arm64"];

export const bundledCatalog: ModelEntry[] = [
  {
    id: "whisper-cpp-base",
    revision: "ggml-base-hf-5359861",
    executor: "whisper.cpp",
    purpose: "RECOGNITION",
    os: osAll,
    architectures: arch,
    accelerators: ["cpu", "cuda", "metal"],
    recognitionLanguages: whisperLanguages.filter(
      (language) => language !== "yue",
    ),
    translationDirections: [],
    downloadBytes: 147951465,
    minimumRamBytes: 1 * 1024 ** 3,
    minimumVramBytes: 0,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    downloadUrl:
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",
    license: "MIT",
    descriptionSource:
      "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py",
  },
  {
    id: "whisper-cpp-small",
    revision: "ggml-small-hf-5359861",
    executor: "whisper.cpp",
    purpose: "RECOGNITION",
    os: osAll,
    architectures: arch,
    accelerators: ["cpu", "cuda", "metal"],
    recognitionLanguages: whisperLanguages.filter(
      (language) => language !== "yue",
    ),
    translationDirections: [],
    downloadBytes: 487601967,
    minimumRamBytes: 2 * 1024 ** 3,
    minimumVramBytes: 0,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    downloadUrl:
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
    license: "MIT",
    descriptionSource:
      "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py",
  },
  ...(JSON.parse(
    readFileSync(
      new URL("./translation-catalog.json", import.meta.url),
      "utf8",
    ),
  ) as ModelEntry[]),
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
