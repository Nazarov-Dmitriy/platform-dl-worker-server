const { availableParallelism } = require("node:os");
function validateProcessing(input) {
  const maxParallel = Number(input.maxParallel ?? 1);
  const cpuThreads = Number(input.cpuThreads ?? Math.max(1, Math.floor(availableParallelism() / 2)));
  const videoMode = input.videoMode ?? "auto", audioMode = input.audioMode ?? "auto";
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 64)
    throw Error("Параллельных заданий должно быть от 1 до 64.");
  if (!Number.isInteger(cpuThreads) || cpuThreads < 1 || cpuThreads > availableParallelism())
    throw Error("Число CPU-потоков должно быть от 1 до " + availableParallelism() + ".");
  if (!["auto", "cpu", "gpu"].includes(videoMode) || !["auto", "cpu", "gpu"].includes(audioMode))
    throw Error("Выберите режим обработки.");
  return { maxParallel, cpuThreads, videoMode, audioMode };
}
module.exports = { validateProcessing };
