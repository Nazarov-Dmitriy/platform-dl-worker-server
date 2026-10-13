import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { Frame, Fence } from "./protocol.js";
import type { ModelEntry, Pair } from "./catalog.js";
export type InstalledModel = {
  id: string;
  revision: string;
  state: "INSTALLED" | "ACTIVE";
  path: string;
  purpose: "RECOGNITION" | "TRANSLATION";
  executor: string;
  recognitionLanguages: string[];
  translationDirections: Pair[];
  minimumRamBytes: number;
};
export type Attempt = {
  jobId: string;
  fence: Fence;
  accept: Frame;
  started: boolean;
  job?: any;
  dir?: string;
  awaitingPublication?: boolean;
  diskBytes?: number;
};
export type State = {
  version: 1;
  attempts: Attempt[];
  outbox: Frame[];
  lastCleanupDate?: string;
  workVolume?: { path: string; dev: number; ino: number };
  models: InstalledModel[];
  catalog: ModelEntry[];
  appliedSettings?: Record<string, unknown>;
  autostart?: boolean;
};
export class Journal {
  state: State = { version: 1, attempts: [], outbox: [], models: [], catalog: [] };
  readonly path: string;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "journal.json");
    if (existsSync(this.path)) {
      this.state = JSON.parse(readFileSync(this.path, "utf8"));
      if (
        this.state.version !== 1 ||
        !Array.isArray(this.state.attempts) ||
        !Array.isArray(this.state.outbox)
      )
        throw new Error("INVALID_JOURNAL");
      this.state.models = Array.isArray(this.state.models)
        ? this.state.models
        : [];
      this.state.catalog = Array.isArray(this.state.catalog)
        ? this.state.catalog
        : [];
    }
  }
  save() {
    const temp = this.path + ".new";
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    if (process.platform !== "win32") {
      const d = openSync(this.dir, "r");
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    }
  }
}
