const test=require("node:test"),assert=require("node:assert/strict");
const {availableParallelism}=require("node:os");
const {validateProcessing}=require("../desktop/processing.cjs");
test("independent video/audio preferences default to auto",()=>{
 const defaults=validateProcessing({}); assert.equal(defaults.videoMode,"auto"); assert.equal(defaults.audioMode,"auto");
 assert.deepEqual(validateProcessing({maxParallel:2,cpuThreads:1,videoMode:"gpu",audioMode:"cpu"}),{maxParallel:2,cpuThreads:1,videoMode:"gpu",audioMode:"cpu"});
});
test("invalid resource and mode values cannot be persisted",()=>{
 for(const settings of [{maxParallel:0},{maxParallel:65},{cpuThreads:0},{cpuThreads:availableParallelism()+1},{videoMode:"cuda"},{audioMode:"invalid"}])assert.throws(()=>validateProcessing(settings));
});
