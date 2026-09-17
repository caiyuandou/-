import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStudentReport} from '../core.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const segments=[{text:'一个 x 只能对应一个 y。'}];
test('学生报告拒绝虚构原话、错误引用和无效例题步骤',()=>{
 const valid={objectives:[{title:'理解映射',source:0}],examples:[{title:'例题',problem:'条件',steps:['步骤'],conclusion:'结论',source:0}],quotes:[{text:'一个 x 只能对应一个 y。',source:0}],checks:[]};assert.equal(validateStudentReport(valid,segments),valid);
 assert.throws(()=>validateStudentReport({...valid,quotes:[{text:'考试必考',source:0}]},segments));
 assert.throws(()=>validateStudentReport({...valid,objectives:[{title:'目标',source:9}]},segments));
 assert.throws(()=>validateStudentReport({...valid,examples:[{...valid.examples[0],steps:[]}]},segments));
 assert.deepEqual(validateStudentReport({},segments).examples,[]);
});
test('学生页面展示配置提示、转义材料并兼容旧报告导出',()=>{
 const text=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');const code=text.slice(text.indexOf('function studentOverview(c){'));
 const ctx={boot:{settings:{deepseekConfigured:false}},E:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),source:i=>'原文'+i,feishuSummary:s=>s||'',feishuChapters:()=>''};vm.createContext(ctx);vm.runInContext(code,ctx);
 assert.match(ctx.studentOverview({level:'大一',subject:'数学',transcript:'已有文字'}),/配置学习分析/);
 const rendered=ctx.studentSections({quotes:[{text:'<script>bad</script>',source:0}],examples:[]});assert.ok(!rendered.includes('<script>'));assert.match(rendered,/旧版学习报告/);assert.equal(typeof ctx.studentExport({}),'string');
});
