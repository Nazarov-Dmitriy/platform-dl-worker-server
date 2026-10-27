const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { validateSettings } = require("../desktop/settings.cjs");
test("public HTTPS needs no manual CA; an explicitly supplied bad CA is still rejected", () => {
  const workDir = mkdtempSync(join(tmpdir(), "worker-public-ca-"));
  try {
    const input = {
      server: "https://194.5.79.198:8090",
      deviceId: "e3e5db94-9fda-4cde-93ee-64f76765e228",
      workDir,
      token: "local-test",
      maxParallel: 1,
    };
    const saved = validateSettings(input);
    assert.equal(saved.ca, "");
    assert.equal(saved.fingerprint, "");
    const invalid = join(workDir, "invalid.crt");
    writeFileSync(invalid, "not a certificate");
    assert.throws(() => validateSettings({ ...input, caPath: invalid }));
    assert.throws(() =>
      validateSettings({ ...input, server: "http://194.5.79.198:8090" }),
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
