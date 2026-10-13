import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import type { Journal } from "./journal.js";
export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
export function modelsDir(workDir: string): string {
  return join(workDir, "models");
}
export function attemptDir(
  workDir: string,
  date: string,
  assignmentId: string,
): string {
  return join(workDir, "files", date, assignmentId);
}
export function assertWorkVolume(workDir: string, journal: Journal) {
  const expected = journal.state.workVolume;
  if (!expected) throw new Error("WORK_VOLUME_UNBOUND");
  const path = realpathSync(workDir);
  const s = statSync(path);
  if (path !== expected.path || s.dev !== expected.dev || s.ino !== expected.ino)
    throw new Error("VOLUME_CHANGED");
  if (!s.isDirectory()) throw new Error("WORK_DIRECTORY_REQUIRED");
}
export function createAttemptDir(
  workDir: string,
  assignmentId: string,
  journal: Journal,
  now = new Date(),
): string {
  assertWorkVolume(workDir, journal);
  const dir = attemptDir(workDir, utcDate(now), assignmentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function cleanupWork(workDir: string, keep: Set<string>) {
  const root = join(workDir, "files");
  if (!existsSync(root)) return;
  for (const date of readdirSync(root)) {
    const day = join(root, date);
    if (!statSync(day).isDirectory()) continue;
    for (const id of readdirSync(day)) {
      const dir = join(day, id);
      if (keep.has(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
    }
    if (readdirSync(day).length === 0) rmSync(day, { recursive: true, force: true });
  }
}
