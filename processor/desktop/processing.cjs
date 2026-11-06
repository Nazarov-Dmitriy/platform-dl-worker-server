const { availableParallelism } = require("node:os");
function rebaseWorkPath(path, fromDir, toDir) {
  if (typeof path !== "string" || !fromDir || !toDir) return path;
  const slash = (p) => String(p).replace(/[\\/]+$/, "").replace(/\//g, "\\");
  const from = slash(fromDir),
    to = slash(toDir),
    value = path.replace(/\//g, "\\");
  if (value.toLowerCase() === from.toLowerCase()) return to;
  const prefix = from + "\\";
  if (value.toLowerCase().startsWith(prefix.toLowerCase()))
    return to + value.slice(from.length);
  return path;
}
function remapWorkDirModels(journal, fromDir, toDir) {
  if (!journal || fromDir === toDir) return journal;
  if (Array.isArray(journal.models))
    for (const model of journal.models)
      model.path = rebaseWorkPath(model.path, fromDir, toDir);
  return journal;
}
function validateModelTasks(input) {
  const raw = input?.modelTasks;
  if (raw == null) return ["speech"];
  if (!Array.isArray(raw) || raw.some((task) => task !== "speech" && task !== "subs" && task !== "generation"))
    throw Error("Выберите задачи этого компьютера.");
  return [...new Set(raw)];
}
function validateProcessing(input) {
  const maxParallel = Number(input.maxParallel ?? 1);
  const cpuThreads = Number(input.cpuThreads ?? Math.max(1, Math.floor(availableParallelism() / 2)));
  const videoMode = input.videoMode ?? "auto", audioMode = input.audioMode ?? "auto", generationMode = input.generationMode ?? "auto";
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 64)
    throw Error("Параллельных заданий должно быть от 1 до 64.");
  if (!Number.isInteger(cpuThreads) || cpuThreads < 1 || cpuThreads > availableParallelism())
    throw Error("Число CPU-потоков должно быть от 1 до " + availableParallelism() + ".");
  if (!["auto", "cpu", "gpu"].includes(videoMode) || !["auto", "cpu", "gpu"].includes(audioMode) || !["auto", "cpu", "gpu"].includes(generationMode))
    throw Error("Выберите режим обработки.");
  return { maxParallel, cpuThreads, videoMode, audioMode, generationMode };
}
module.exports = { validateProcessing, validateModelTasks, remapWorkDirModels, rebaseWorkPath };
