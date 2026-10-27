import test from "node:test";
import assert from "node:assert/strict";
import { selectVideoEncoder, videoCodecArgs } from "../encoding.js";
test("video preference respects the requested profile and GPU availability", () => {
 assert.equal(selectVideoEncoder("auto","HARDWARE_ALLOWED",true),"h264_nvenc");
 assert.equal(selectVideoEncoder("auto","HARDWARE_ALLOWED",false),"libx264");
 assert.equal(selectVideoEncoder("cpu","HARDWARE_ALLOWED",true),"libx264");
 assert.equal(selectVideoEncoder("auto","X264_EXACT",true),"libx264");
 assert.throws(()=>selectVideoEncoder("gpu","X264_EXACT",true),/PROFILE_REQUIRES_CPU/);
 assert.throws(()=>selectVideoEncoder("gpu","HARDWARE_ALLOWED",false),/GPU_UNAVAILABLE/);
});
test("NVENC and CPU receive separate rate control options with bounded CPU threads", () => {
 const cpu=videoCodecArgs("libx264","slow",25,1200,3);
 assert.equal(cpu[cpu.indexOf("-threads")+1],"3");
 const gpu=videoCodecArgs("h264_nvenc","slow",25,1200,3);
 assert.ok(!gpu.includes("-crf")); assert.ok(gpu.includes("1200k")); assert.ok(gpu.includes("p5"));
});
