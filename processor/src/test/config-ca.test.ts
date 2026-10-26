import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";

test("dispatcher CA path is relative to config and persists for service startup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "processor-ca-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const example = JSON.parse(readFileSync(fileURLToPath(new URL("../../config.example.json", import.meta.url)), "utf8"));
  const config = join(root, "config.json");
  writeFileSync(join(root, "device-ca.crt"), "-----BEGIN CERTIFICATE-----\nconfiguration-path-fixture\n-----END CERTIFICATE-----\n");
  writeFileSync(config, JSON.stringify({ ...example, tlsCaFile: "device-ca.crt" }));
  assert.equal(loadConfig(config).tlsCaFile, join(root, "device-ca.crt"));
  writeFileSync(config, JSON.stringify(example));
  assert.equal(loadConfig(config).tlsCaFile, undefined);
  for (const invalid of ["", false, 1]) {
    writeFileSync(config, JSON.stringify({ ...example, tlsCaFile: invalid }));
    assert.throws(() => loadConfig(config), /INVALID_TLS_CA_FILE/);
  }
  writeFileSync(config, JSON.stringify({ ...example, tlsCaFile: "missing.crt" }));
  assert.throws(() => loadConfig(config), /ENOENT/);
});
