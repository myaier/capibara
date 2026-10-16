import test from "node:test";
import assert from "node:assert/strict";
import {nativeChildResult} from "../shared/native-results";
import {normalizeTimelinePage} from "../shared/timeline";
import type {ProviderSubagent} from "../shared/provider-subagents";
const child:ProviderSubagent={id:"child",parentAgentId:"parent",provider:"test",title:"task",description:null,status:"completed",createdAt:"2026-09-17T10:00:00Z",updatedAt:"2026-09-17T11:00:00Z"};
const row=(seq:number,type:string,text:string)=>({seq,item:{type,text},timestamp:"2026-09-17T10:00:00Z"});
test("native results pin independently confirmed first input and newest reply",()=>{
 const head={epoch:"e",rows:[row(1,"user_message","original input")],window:{minSeq:1}};
 const tail=normalizeTimelinePage({epoch:"e",rows:[row(20,"user_message","follow up"),row(21,"assistant_message","latest result")],hasOlder:true});
 const result=nativeChildResult("parent",child,tail,head);assert.equal(result.firstInput?.text,"original input");assert.equal(result.latestReply?.text,"latest result");assert.equal(result.coverage.firstInputConfirmed,true);assert.equal(result.isFinal,true);
});
test("native tail input is never presented as first and previous-turn replies are excluded",()=>{
 const tail=normalizeTimelinePage({epoch:"e",rows:[row(20,"assistant_message","old reply"),row(21,"user_message","new turn")]});
 const result=nativeChildResult("parent",{...child,status:"running"},tail,{epoch:"e",rows:[row(10,"user_message","not first")],window:{minSeq:10}});
 assert.equal(result.firstInput,null);assert.equal(result.latestReply,null);assert.equal(result.isRunning,true);assert.equal(result.coverage.firstInputConfirmed,false);
});
test("native first-input epoch mismatch does not mix histories",()=>{
 const result=nativeChildResult("parent",child,normalizeTimelinePage({epoch:"new",rows:[row(1,"assistant_message","new history")]}),{epoch:"old",rows:[row(1,"user_message","old input")],window:{minSeq:1}});
 assert.equal(result.firstInput,null);assert.equal(result.latestReply?.text,"new history");
});
