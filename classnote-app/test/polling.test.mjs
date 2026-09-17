import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function pollFeishu(){'),source.indexOf('setInterval(pollFeishu,10000)'));
function setup(){let calls=0;const c={id:'c1',audio:{name:'a'},transcript:'',feishu:{minuteToken:'m1',audioName:'a'}};const ctx={current:c,view:'course',lessonTab:'feishu',busy:false,dirty:false,feishuPolling:false,document:{hidden:false},feishuPollErrors:{},feishuPollCounts:{},routeVersion:1,lessonBody(){},api:async()=>{calls++;return {...c,transcript:'原文',segments:[],feishu:{...c.feishu,status:'ready',result:{summary:'摘要'}}};}};vm.createContext(ctx);vm.runInContext(code,ctx);return {ctx,calls:()=>calls};}
test('自动同步暂停编辑、保留待确认原文、完成后停止',async()=>{const {ctx,calls}=setup();ctx.dirty=true;await ctx.pollFeishu();assert.equal(calls(),0);ctx.dirty=false;ctx.current.transcript='自己的原文';await ctx.pollFeishu();assert.equal(calls(),0);ctx.current.transcript='';await ctx.pollFeishu();assert.equal(calls(),1);assert.equal(ctx.current.transcript,'原文');await ctx.pollFeishu();assert.equal(calls(),1);});
test('自动同步错误后停止，离开页面和达到次数上限时不请求',async()=>{const {ctx,calls}=setup();ctx.lessonTab='notes';await ctx.pollFeishu();assert.equal(calls(),0);ctx.lessonTab='feishu';ctx.feishuPollCounts.c1=60;await ctx.pollFeishu();assert.equal(calls(),0);ctx.feishuPollCounts.c1=0;let failures=0;ctx.api=async()=>{failures++;throw Error('授权失效')};await ctx.pollFeishu();await ctx.pollFeishu();assert.equal(failures,1);assert.equal(ctx.feishuPollErrors.c1,'授权失效');assert.equal(ctx.feishuPolling,false);});
