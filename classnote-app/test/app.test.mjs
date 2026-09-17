import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {parseTranscript,validateReport} from '../core.mjs';
const baseDir=new URL('../.test-data/',import.meta.url);mkdirSync(baseDir,{recursive:true});
test('时间戳原文解析，普通文字不伪造时间',()=>{
 const s=parseTranscript('1\n00:00:04,200 --> 00:00:08,000\n加速度等于合外力除以质量。\n\n[01:20] 第二个知识点\n没有时间的文字');
 assert.equal(parseTranscript('2026')[0].text,'2026');assert.equal(s[0].start,4.2);assert.equal(s[1].start,80);assert.equal(s[2].start,null);
});
test('无效原文索引会被拒绝',()=>{
 assert.throws(()=>validateReport({summary:'x',outline:[{title:'x',detail:'x',source:7}],terms:[],questions:[],cards:[],pitfalls:[],review:[]},1),/引用/);
});
test('课程持久化、配置保护、AI适配、音频Range、自测错题及计划闭环',async()=>{
 const dir=mkdtempSync(join(baseDir.pathname.replace(/^\/([A-Z]:)/i,'$1'),'run-'));
 const report={summary:'质量一定，加速度与合外力成正比。',outline:[{title:'力与加速度',detail:'F合=ma。',source:0}],terms:[{term:'加速度',explanation:'速度变化率。',source:0}],pitfalls:['不要把拉力直接当合外力。'],questions:[{question:'质量一定，合外力加倍，加速度如何变化？',options:['加倍','不变','减半','归零'],answer:0,explanation:'由牛顿第二定律可知加倍。',source:0}],cards:[{front:'牛顿第二定律？',back:'F合=ma。',source:0}],review:[{title:'复习受力分析',minutes:15}]};
 let calls=0;
 const mockFetch=async(url,options)=>{calls++;if(url.includes('audio/transcriptions'))return new Response(JSON.stringify({text:'质量一定时，加速度与合外力成正比。'}));const b=JSON.parse(options.body);assert.equal(options.headers.Authorization,'Bearer test-placeholder-key');if(!b.response_format)return new Response(JSON.stringify({choices:[{message:{content:'连接成功'},finish_reason:'stop'}]}));const isAsk=b.messages[0].content.includes('"sources"');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(isAsk?{answer:'质量一定时，合外力越大，加速度越大。',sources:[0]}:report)},finish_reason:'stop'}]}));};
 let app=createApp({dataDir:dir,fetchImpl:mockFetch});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let origin='http://127.0.0.1:'+app.server.address().port;
 const req=async(path,method='GET',data)=>{const r=await fetch(origin+'/api'+path,{method,headers:{'X-Classnote-Request':'1','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return{status:r.status,data:await r.json()};};
 try{
 assert.equal((await req('/bootstrap')).data.courses.length,0);
 const csrf=await fetch(origin+'/api/courses',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
 const denied=await fetch(origin+'/api/courses',{method:'POST',headers:{'Content-Type':'application/json','X-Classnote-Request':'1',Origin:'https://other.example'},body:'{}'});assert.equal(denied.status,403);
 const created=await req('/courses','POST',{title:'测试物理',subject:'物理',level:'高中'});assert.equal(created.status,201);const id=created.data.id;
 assert.equal((await req('/courses/'+id+'/generate','POST',{})).status,400);
 await req('/courses/'+id,'PUT',{transcript:'质量一定时，加速度与合外力成正比。',notes:'我自己的笔记'});
 assert.equal((await req('/courses/'+id+'/generate','POST',{})).status,503);
 await req('/settings','PUT',{deepseekKey:'test-placeholder-key',asrKey:'test-asr-key',model:'deepseek-flash'});
 const settings=(await req('/settings')).data;assert.equal(settings.deepseekConfigured,true);assert.equal(settings.deepseekKey,undefined);
 assert.equal((await req('/settings/test','POST',{})).status,200);
 const generated=(await req('/courses/'+id+'/generate','POST',{})).data;assert.equal(generated.report.questions.length,1);assert.equal(generated.notes,'我自己的笔记');
 const qid=generated.report.questions[0].id;
 assert.equal((await req('/courses/'+id+'/answer','POST',{questionId:qid,choice:8})).status,400);
 assert.equal((await req('/courses/'+id+'/answer','POST',{questionId:qid,choice:1})).data.correct,false);
 assert.equal((await req('/mistakes')).data.length,1);
 assert.equal((await req('/courses/'+id+'/answer','POST',{questionId:qid,choice:0})).data.correct,true);
 assert.equal((await req('/mistakes')).data.length,0);
 const chat=(await req('/courses/'+id+'/ask','POST',{question:'解释一下'})).data;assert.equal(chat.chat.length,1);
 const card=generated.report.cards[0].id;assert.equal((await req('/courses/'+id+'/card','POST',{cardId:card,known:true})).data[card].known,true);
 const t=(await req('/tasks','POST',{title:'复习公式',date:'2026-09-16',minutes:15,courseId:id})).data;
 assert.equal((await req('/tasks/'+t.id,'PATCH',{done:true})).data.done,true);
 const buf=Buffer.alloc(100,42);const up=await fetch(origin+'/api/courses/'+id+'/audio',{method:'POST',headers:{'X-Classnote-Request':'1','X-Filename':'test.wav','Content-Type':'application/octet-stream'},body:buf});assert.equal(up.status,200);
 const range=await fetch(origin+'/api/courses/'+id+'/audio',{headers:{Range:'bytes=0-9'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,10);
 const badRange=await fetch(origin+'/api/courses/'+id+'/audio',{headers:{Range:'bytes=1000-'}});assert.equal(badRange.status,416);
 const tr=(await req('/courses/'+id+'/transcribe','POST',{})).data;assert.equal(tr.segments[0].start,null);assert.equal(tr.report,null);assert.equal(tr.notes,'我自己的笔记');
 await new Promise(r=>app.server.close(r));app.close();
 app=createApp({dataDir:dir,fetchImpl:mockFetch});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+app.server.address().port;
 const persisted=(await req('/courses/'+id)).data;assert.equal(persisted.notes,'我自己的笔记');assert.ok(persisted.audio);assert.equal((await req('/settings')).data.deepseekConfigured,true);
 assert.equal((await req('/bootstrap')).data.tasks[0].done,true);assert.ok(calls>=4);
 }finally{await new Promise(r=>app.server.close(r));app.close();}
});


