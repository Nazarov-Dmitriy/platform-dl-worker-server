import test from "node:test";
import assert from "node:assert/strict";
import { VideoProgress } from "../video-progress.js";
test("media progress handles split lines, unknown timestamps and duration limits", () => {
  const values: number[] = []; const parser = new VideoProgress(100, n => values.push(n));
  parser.push("out_time_us=2500"); parser.push("0000\nout_time_us=N/A\nout_time_us=-1\nout_time_us=200000000\nprogress=end\n");
  assert.deepEqual(values, [0.25, 0, 1, 1]);
});
test("unknown duration never invents a timed percentage", () => {
  const values: number[] = []; const parser = new VideoProgress(0, n => values.push(n));
  parser.push("out_time_us=25000000\n"); assert.deepEqual(values, []);
});
