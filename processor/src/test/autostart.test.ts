import test from "node:test";
import assert from "node:assert/strict";
import { setAutostart } from "../autostart.js";
import type { Config } from "../config.js";
test("desktop autostart uses native host bridge without plaintext token file or OS scripts", async () => {
  const called: boolean[] = [];
  const config = {
    desktopAutostart: async (enabled: boolean) => {
      called.push(enabled);
    },
  } as Config;
  await setAutostart(config, true, "test-only-token");
  await setAutostart(config, false, "test-only-token");
  assert.deepEqual(called, [true, false]);
  config.desktopAutostart = async () => {
    throw Error("native registration failed");
  };
  await assert.rejects(
    setAutostart(config, true, "test-only-token"),
    /native registration failed/,
  );
});
