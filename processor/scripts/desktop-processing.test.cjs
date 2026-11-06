const test=require("node:test"),assert=require("node:assert/strict");
const {availableParallelism}=require("node:os");
const {validateProcessing,validateModelTasks,remapWorkDirModels}=require("../desktop/processing.cjs");
test("independent video/audio preferences default to auto",()=>{
 const defaults=validateProcessing({}); assert.equal(defaults.videoMode,"auto"); assert.equal(defaults.audioMode,"auto"); assert.equal(defaults.generationMode,"auto");
 assert.deepEqual(validateProcessing({maxParallel:2,cpuThreads:1,videoMode:"gpu",audioMode:"cpu",generationMode:"gpu"}),{maxParallel:2,cpuThreads:1,videoMode:"gpu",audioMode:"cpu",generationMode:"gpu"});
});
test("changing work folder rebases model paths under the new directory",()=>{
 const journal={models:[
  {id:"whisper",path:"G:\\обработка фото\\models\\whisper-cpp-small\\payload"},
  {id:"other",path:"D:\\keep\\model.bin"},
 ]};
 remapWorkDirModels(journal,"G:\\обработка фото","G:\\worker-server-folder");
 assert.equal(journal.models[0].path,"G:\\worker-server-folder\\models\\whisper-cpp-small\\payload");
 assert.equal(journal.models[1].path,"D:\\keep\\model.bin");
});
test("model task checkboxes persist as speech and subs",()=>{
 assert.deepEqual(validateModelTasks({}),["speech"]);
 assert.deepEqual(validateModelTasks({modelTasks:["speech","subs"]}),["speech","subs"]);
 assert.deepEqual(validateModelTasks({modelTasks:[]}),[]);
 assert.deepEqual(validateModelTasks({modelTasks:["generation","speech"]}),["generation","speech"]);
 assert.throws(()=>validateModelTasks({modelTasks:["video"]}));
});
test("invalid resource and mode values cannot be persisted",()=>{
 for(const settings of [{maxParallel:0},{maxParallel:65},{cpuThreads:0},{cpuThreads:availableParallelism()+1},{videoMode:"cuda"},{audioMode:"invalid"},{generationMode:"invalid"}])assert.throws(()=>validateProcessing(settings));
});
